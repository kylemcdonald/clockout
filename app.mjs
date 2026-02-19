import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const server = createServer(app);

// WebSocket server setup
const wss = new WebSocketServer({ server });
const clientsByApiKey = new Map(); // Map<apiKey, Set<WebSocket>>

wss.on('connection', (ws, req) => {
    // Extract API key from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const apiKey = url.searchParams.get('api_key');

    if (!apiKey || !validateApiKey(apiKey)) {
        ws.close(1008, 'Invalid API key');
        return;
    }

    // Store connection by API key
    if (!clientsByApiKey.has(apiKey)) {
        clientsByApiKey.set(apiKey, new Set());
    }
    clientsByApiKey.get(apiKey).add(ws);

    ws.apiKey = apiKey;

    ws.on('close', () => {
        const clients = clientsByApiKey.get(apiKey);
        if (clients) {
            clients.delete(ws);
            if (clients.size === 0) {
                clientsByApiKey.delete(apiKey);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Broadcast update to all clients with the same API key
function broadcastUpdate(apiKey, type, data) {
    const clients = clientsByApiKey.get(apiKey);
    if (!clients) return;

    const message = JSON.stringify({ type, data });
    clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
        }
    });
}

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const db = new Database('clockout.db');
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        target_hours REAL NOT NULL,
        color TEXT,
        visible INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
        UNIQUE(api_key_id, name)
    );
`);

// Add visible column to existing projects table if it doesn't exist
try {
    const tableInfo = db.prepare("PRAGMA table_info(projects)").all();
    const hasVisibleColumn = tableInfo.some(col => col.name === 'visible');
    if (!hasVisibleColumn) {
        db.exec('ALTER TABLE projects ADD COLUMN visible INTEGER DEFAULT 1');
    }
} catch (error) {
    // Table might not exist yet, which is fine
    console.log('Note: Could not check for visible column:', error.message);
}

// Add name column to existing api_keys table if it doesn't exist
try {
    const tableInfo = db.prepare("PRAGMA table_info(api_keys)").all();
    const hasNameColumn = tableInfo.some(col => col.name === 'name');
    if (!hasNameColumn) {
        db.exec('ALTER TABLE api_keys ADD COLUMN name TEXT');
    }
} catch (error) {
    console.log('Note: Could not check for name column:', error.message);
}

db.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
`);

// Reconcile historical data where multiple running entries exist for one API key.
// Keep the newest running entry and close older ones at the newest start_time.
function reconcileRunningEntriesForConstraints() {
    const rows = db.prepare(`
        SELECT id, api_key_id, start_time
        FROM time_entries
        WHERE end_time IS NULL
        ORDER BY api_key_id, start_time DESC, id DESC
    `).all();

    const rowsByApiKey = new Map();
    rows.forEach(row => {
        if (!rowsByApiKey.has(row.api_key_id)) {
            rowsByApiKey.set(row.api_key_id, []);
        }
        rowsByApiKey.get(row.api_key_id).push(row);
    });

    const reconcile = db.transaction(() => {
        let closedCount = 0;
        const closeStmt = db.prepare('UPDATE time_entries SET end_time = ? WHERE id = ? AND end_time IS NULL');
        for (const [, runningEntries] of rowsByApiKey.entries()) {
            if (runningEntries.length <= 1) continue;
            const newest = runningEntries[0];
            for (const stale of runningEntries.slice(1)) {
                closeStmt.run(newest.start_time, stale.id);
                closedCount += 1;
            }
        }
        return closedCount;
    });

    const closed = reconcile();
    if (closed > 0) {
        console.warn(`Reconciled ${closed} stale running time entries before applying unique running-entry constraint.`);
    }
}

reconcileRunningEntriesForConstraints();
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_running_per_api_key
    ON time_entries(api_key_id)
    WHERE end_time IS NULL
`);

// Helper function to get API key from request
function getApiKey(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    return req.headers['x-api-key'] || req.query.api_key || req.body?.api_key;
}

// Helper function to validate API key
function validateApiKey(apiKey) {
    if (!apiKey) {
        return null;
    }
    const stmt = db.prepare('SELECT id FROM api_keys WHERE api_key = ?');
    const result = stmt.get(apiKey);
    return result ? result.id : null;
}

// Middleware to require API key authentication
function requireApiKey(req, res, next) {
    const apiKey = getApiKey(req);
    const apiKeyId = validateApiKey(apiKey);
    if (!apiKeyId) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    req.apiKeyId = apiKeyId;
    req.apiKey = apiKey;
    next();
}

// Password for /api route (required from environment variable)
if (!process.env.ADMIN_PASSWORD) {
    console.error('ERROR: ADMIN_PASSWORD environment variable is required.');
    console.error('Please create a .env file with ADMIN_PASSWORD=your-password');
    process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Middleware for admin password protection
function requireAdminPassword(req, res, next) {
    const password = req.headers['x-admin-password'] || req.body.password || req.query.password;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redirect old routes to single-page app
app.get('/history', (req, res) => {
    res.redirect('/');
});

app.get('/settings', (req, res) => {
    res.redirect('/');
});

// Get current user's projects
app.get('/api/projects', requireApiKey, (req, res) => {
    try {
        const includeHidden = req.query.include_hidden === 'true';
        let query = 'SELECT id, name, target_hours, color, visible FROM projects WHERE api_key_id = ?';
        if (!includeHidden) {
            query += ' AND (visible IS NULL OR visible = 1)';
        }
        query += ' ORDER BY target_hours DESC';
        const stmt = db.prepare(query);
        const projects = stmt.all(req.apiKeyId);
        res.json(projects);
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add a new project
app.post('/api/projects', requireApiKey, (req, res) => {
    try {
        const { name, target_hours, color } = req.body;
        if (!name || target_hours === undefined) {
            return res.status(400).json({ error: 'Name and target_hours are required' });
        }
        const targetHours = parseFloat(target_hours);
        if (!Number.isFinite(targetHours) || targetHours <= 0) {
            return res.status(400).json({ error: 'target_hours must be a positive number' });
        }
        
        const colors = ['#f94144', '#f3722c', '#f8961e', '#f9844a', '#f9c74f', '#90be6d', '#43aa8b', '#4d908e', '#577590', '#277da1'];
        const projectColor = color || colors[Math.floor(Math.random() * colors.length)];
        
        const stmt = db.prepare('INSERT INTO projects (api_key_id, name, target_hours, color) VALUES (?, ?, ?, ?)');
        const result = stmt.run(req.apiKeyId, name, targetHours, projectColor);
        const newProject = { id: result.lastInsertRowid, name, target_hours: targetHours, color: projectColor, visible: 1 };
        broadcastUpdate(req.apiKey, 'project_created', newProject);
        res.json(newProject);
    } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: 'Project with this name already exists' });
        }
        console.error('Error adding project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a project
app.put('/api/projects/:id', requireApiKey, (req, res) => {
    try {
        const projectId = parseInt(req.params.id);
        if (!Number.isInteger(projectId)) {
            return res.status(400).json({ error: 'Invalid project id' });
        }
        const { name, target_hours, visible } = req.body;
        if (!name || target_hours === undefined) {
            return res.status(400).json({ error: 'Name and target_hours are required' });
        }
        const targetHours = parseFloat(target_hours);
        if (!Number.isFinite(targetHours) || targetHours <= 0) {
            return res.status(400).json({ error: 'target_hours must be a positive number' });
        }
        
        let query = 'UPDATE projects SET name = ?, target_hours = ?';
        const params = [name, targetHours];
        
        if (visible !== undefined) {
            query += ', visible = ?';
            params.push(visible ? 1 : 0);
        }
        
        query += ' WHERE id = ? AND api_key_id = ?';
        params.push(projectId, req.apiKeyId);
        
        const stmt = db.prepare(query);
        const result = stmt.run(...params);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        // Fetch updated project
        const getStmt = db.prepare('SELECT id, name, target_hours, color, visible FROM projects WHERE id = ?');
        const project = getStmt.get(projectId);
        broadcastUpdate(req.apiKey, 'project_updated', project);
        res.json(project);
    } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: 'Project with this name already exists' });
        }
        console.error('Error updating project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Randomize project colors
app.post('/api/projects/randomize-colors', requireApiKey, (req, res) => {
    try {
        const colors = ['#f94144', '#f3722c', '#f8961e', '#f9844a', '#f9c74f', '#90be6d', '#43aa8b', '#4d908e', '#577590', '#277da1'];

        // Get all projects for this API key
        const getStmt = db.prepare('SELECT id FROM projects WHERE api_key_id = ?');
        const projects = getStmt.all(req.apiKeyId);

        // Shuffle colors and assign to projects
        const shuffledColors = [...colors].sort(() => Math.random() - 0.5);
        const updateStmt = db.prepare('UPDATE projects SET color = ? WHERE id = ?');

        projects.forEach((project, index) => {
            const color = shuffledColors[index % shuffledColors.length];
            updateStmt.run(color, project.id);
        });

        // Get updated projects
        const getAllStmt = db.prepare('SELECT id, name, target_hours, color, visible FROM projects WHERE api_key_id = ?');
        const updatedProjects = getAllStmt.all(req.apiKeyId);

        broadcastUpdate(req.apiKey, 'projects_updated', updatedProjects);
        res.json({ success: true, projects: updatedProjects });
    } catch (error) {
        console.error('Error randomizing colors:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a project
app.delete('/api/projects/:id', requireApiKey, (req, res) => {
    try {
        const projectId = parseInt(req.params.id);
        if (!Number.isInteger(projectId)) {
            return res.status(400).json({ error: 'Invalid project id' });
        }
        const stmt = db.prepare('DELETE FROM projects WHERE id = ? AND api_key_id = ?');
        const result = stmt.run(projectId, req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        broadcastUpdate(req.apiKey, 'project_deleted', { id: projectId });
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get current running time entry
app.get('/api/time-entries/current', requireApiKey, (req, res) => {
    try {
        // Get the current running entry
        const stmt = db.prepare(`
            SELECT te.id, te.project_id, te.start_time, p.name as project_name
            FROM time_entries te
            JOIN projects p ON te.project_id = p.id
            WHERE te.api_key_id = ? AND te.end_time IS NULL
            ORDER BY te.start_time DESC
            LIMIT 1
        `);
        const entry = stmt.get(req.apiKeyId);

        if (entry) {
            res.json({
                id: entry.id,
                project_id: entry.project_id,
                start: entry.start_time,
                name: entry.project_name
            });
        } else {
            res.json(null);
        }
    } catch (error) {
        console.error('Error fetching current time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get time entries - optionally filtered to last 168 hours
app.get('/api/time-entries', requireApiKey, (req, res) => {
    try {
        const showAll = req.query.all === 'true';
        let entries;

        if (showAll) {
            // Return all entries for history page
            const stmt = db.prepare(`
                SELECT te.id, te.project_id, te.start_time, te.end_time, p.name as project_name
                FROM time_entries te
                JOIN projects p ON te.project_id = p.id
                WHERE te.api_key_id = ?
                ORDER BY te.start_time DESC
            `);
            entries = stmt.all(req.apiKeyId);
        } else {
            // Return entries for last 168 hours (filter by end_time or running tasks)
            const windowStart = new Date(Date.now() - 168 * 60 * 60 * 1000);
            const stmt = db.prepare(`
                SELECT te.id, te.project_id, te.start_time, te.end_time, p.name as project_name
                FROM time_entries te
                JOIN projects p ON te.project_id = p.id
                WHERE te.api_key_id = ?
                  AND (te.end_time >= ? OR te.end_time IS NULL)
                ORDER BY te.start_time DESC
            `);
            entries = stmt.all(req.apiKeyId, windowStart.toISOString());
        }

        res.json(entries.map(entry => ({
            id: entry.id,
            project_id: entry.project_id,
            start: entry.start_time,
            stop: entry.end_time,
            duration: entry.end_time
                ? Math.floor((new Date(entry.end_time) - new Date(entry.start_time)) / 1000)
                : -1,
            name: entry.project_name
        })));
    } catch (error) {
        console.error('Error fetching time entries:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start a new time entry (or create a completed entry if start_time and end_time provided)
app.post('/api/time-entries', requireApiKey, (req, res) => {
    try {
        const { project_id, start_time, end_time } = req.body;
        if (!project_id) {
            return res.status(400).json({ error: 'project_id is required' });
        }
        const projectId = parseInt(project_id);
        if (!Number.isInteger(projectId)) {
            return res.status(400).json({ error: 'project_id must be a valid integer' });
        }

        // Verify project belongs to this API key
        const projectStmt = db.prepare('SELECT id, name FROM projects WHERE id = ? AND api_key_id = ?');
        const project = projectStmt.get(projectId, req.apiKeyId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // If both start_time and end_time provided, create a completed entry directly
        if (start_time && end_time) {
            const startDate = new Date(start_time);
            const endDate = new Date(end_time);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                return res.status(400).json({ error: 'start_time and end_time must be valid ISO date strings' });
            }
            if (startDate >= endDate) {
                return res.status(400).json({ error: 'start_time must be before end_time' });
            }
            const insertStmt = db.prepare('INSERT INTO time_entries (api_key_id, project_id, start_time, end_time) VALUES (?, ?, ?, ?)');
            const normalizedStart = startDate.toISOString();
            const normalizedEnd = endDate.toISOString();
            const result = insertStmt.run(req.apiKeyId, projectId, normalizedStart, normalizedEnd);
            const newEntry = {
                id: result.lastInsertRowid,
                project_id: projectId,
                start: normalizedStart,
                stop: normalizedEnd,
                name: project.name
            };
            broadcastUpdate(req.apiKey, 'time_entry_created', newEntry);
            return res.json(newEntry);
        }

        // Use a transaction to atomically stop any running entries and start a new one
        // This prevents race conditions where concurrent requests could create multiple running entries
        const startTime = new Date().toISOString();
        const startNewEntry = db.transaction((apiKeyId, projectId, start) => {
            // Stop any currently running time entries
            const stopStmt = db.prepare('UPDATE time_entries SET end_time = ? WHERE api_key_id = ? AND end_time IS NULL');
            stopStmt.run(start, apiKeyId);

            // Start new time entry
            const insertStmt = db.prepare('INSERT INTO time_entries (api_key_id, project_id, start_time) VALUES (?, ?, ?)');
            const result = insertStmt.run(apiKeyId, projectId, start);
            return result.lastInsertRowid;
        });

        const newEntryId = startNewEntry(req.apiKeyId, projectId, startTime);

        const newEntry = {
            id: newEntryId,
            project_id: projectId,
            start: startTime,
            stop: null,
            name: project.name
        };
        broadcastUpdate(req.apiKey, 'time_entry_started', newEntry);
        res.json(newEntry);
    } catch (error) {
        if (error.message.includes('idx_time_entries_one_running_per_api_key')) {
            return res.status(409).json({ error: 'Another running entry already exists for this API key' });
        }
        console.error('Error starting time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop current time entry
app.patch('/api/time-entries/:id/stop', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
        if (!Number.isInteger(entryId)) {
            return res.status(400).json({ error: 'Invalid time entry id' });
        }
        const endTime = new Date().toISOString();
        const stmt = db.prepare('UPDATE time_entries SET end_time = ? WHERE id = ? AND api_key_id = ? AND end_time IS NULL');
        const result = stmt.run(endTime, entryId, req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found or already stopped' });
        }
        broadcastUpdate(req.apiKey, 'time_entry_stopped', { id: entryId, end_time: endTime });
        res.json({ success: true });
    } catch (error) {
        console.error('Error stopping time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a time entry (start_time and/or end_time)
app.put('/api/time-entries/:id', requireApiKey, (req, res) => {
    try {
        const { start_time, end_time, project_id } = req.body;
        const entryId = parseInt(req.params.id);
        if (!Number.isInteger(entryId)) {
            return res.status(400).json({ error: 'Invalid time entry id' });
        }

        // Validate input
        if (!start_time && end_time === undefined && !project_id) {
            return res.status(400).json({ error: 'Either start_time, end_time, or project_id must be provided' });
        }

        const existingStmt = db.prepare('SELECT id, project_id, start_time, end_time FROM time_entries WHERE id = ? AND api_key_id = ?');
        const existingEntry = existingStmt.get(entryId, req.apiKeyId);
        if (!existingEntry) {
            return res.status(404).json({ error: 'Time entry not found' });
        }

        const parsedProjectId = project_id ? parseInt(project_id) : null;
        if (project_id && !Number.isInteger(parsedProjectId)) {
            return res.status(400).json({ error: 'project_id must be a valid integer' });
        }

        // Validate project_id if provided
        if (project_id) {
            const projectStmt = db.prepare('SELECT id FROM projects WHERE id = ? AND api_key_id = ?');
            const project = projectStmt.get(parsedProjectId, req.apiKeyId);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
        }

        // Validate date formats if provided
        const validateDate = (dateStr, fieldName) => {
            if (!dateStr) return;
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) {
                throw new Error(`Invalid ${fieldName} format. Must be ISO date string.`);
            }
            return date.toISOString();
        };

        const validatedStartTime = start_time ? validateDate(start_time, 'start_time') : null;
        const validatedEndTime = end_time !== undefined ? (end_time ? validateDate(end_time, 'end_time') : null) : undefined;

        const finalStartTime = validatedStartTime ?? existingEntry.start_time;
        const finalEndTime = validatedEndTime !== undefined ? validatedEndTime : existingEntry.end_time;

        // Ensure start is before end when end exists
        if (finalEndTime && new Date(finalStartTime) >= new Date(finalEndTime)) {
            return res.status(400).json({ error: 'start_time must be before end_time' });
        }

        // Prevent multiple running entries for one API key when reopening an entry
        if (finalEndTime === null) {
            const otherRunningStmt = db.prepare(`
                SELECT id
                FROM time_entries
                WHERE api_key_id = ? AND end_time IS NULL AND id != ?
                LIMIT 1
            `);
            const otherRunning = otherRunningStmt.get(req.apiKeyId, entryId);
            if (otherRunning) {
                return res.status(409).json({ error: 'Another running entry already exists for this API key' });
            }
        }

        // Build update query dynamically
        const updates = [];
        const params = [];
        if (validatedStartTime !== null) {
            updates.push('start_time = ?');
            params.push(validatedStartTime);
        }
        if (validatedEndTime !== undefined) {
            updates.push('end_time = ?');
            params.push(validatedEndTime);
        }
        if (project_id) {
            updates.push('project_id = ?');
            params.push(parsedProjectId);
        }

        // Add WHERE conditions
        params.push(entryId, req.apiKeyId);

        const stmt = db.prepare(`UPDATE time_entries SET ${updates.join(', ')} WHERE id = ? AND api_key_id = ?`);
        const result = stmt.run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found' });
        }

        broadcastUpdate(req.apiKey, 'time_entry_updated', { id: entryId, start_time: validatedStartTime, end_time: validatedEndTime });
        res.json({ success: true });
    } catch (error) {
        if (error.message.includes('idx_time_entries_one_running_per_api_key')) {
            return res.status(409).json({ error: 'Another running entry already exists for this API key' });
        }
        console.error('Error updating time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Shift an entry start backward and optionally shift a linked entry end backward in one transaction
app.patch('/api/time-entries/:id/shift-start', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
        const minutes = Number(req.body.minutes);
        const hasPreviousEntryId = req.body.previous_entry_id !== undefined && req.body.previous_entry_id !== null && req.body.previous_entry_id !== '';
        const previousEntryId = hasPreviousEntryId ? parseInt(req.body.previous_entry_id) : null;

        if (!Number.isInteger(entryId)) {
            return res.status(400).json({ error: 'Invalid time entry id' });
        }
        if (!Number.isFinite(minutes) || minutes <= 0) {
            return res.status(400).json({ error: 'minutes must be a positive number' });
        }
        if (hasPreviousEntryId && !Number.isInteger(previousEntryId)) {
            return res.status(400).json({ error: 'previous_entry_id must be a valid integer' });
        }

        const shiftMs = Math.round(minutes * 60 * 1000);
        const applyShift = db.transaction(() => {
            const getEntry = db.prepare('SELECT id, start_time, end_time FROM time_entries WHERE id = ? AND api_key_id = ?');
            const current = getEntry.get(entryId, req.apiKeyId);
            if (!current) {
                return { error: { code: 404, message: 'Time entry not found' } };
            }

            const oldStart = new Date(current.start_time);
            if (isNaN(oldStart.getTime())) {
                return { error: { code: 500, message: 'Existing start_time is invalid' } };
            }
            const newStart = new Date(oldStart.getTime() - shiftMs).toISOString();
            if (current.end_time && new Date(newStart) >= new Date(current.end_time)) {
                return { error: { code: 400, message: 'Shift would make start_time >= end_time' } };
            }

            if (previousEntryId) {
                const previous = getEntry.get(previousEntryId, req.apiKeyId);
                if (!previous) {
                    return { error: { code: 404, message: 'Linked previous entry not found' } };
                }
                if (!previous.end_time) {
                    return { error: { code: 400, message: 'Linked previous entry must be completed' } };
                }
                const previousEnd = new Date(previous.end_time);
                const newPreviousEnd = new Date(previousEnd.getTime() - shiftMs).toISOString();
                if (new Date(previous.start_time) >= new Date(newPreviousEnd)) {
                    return { error: { code: 400, message: 'Shift would make linked previous entry invalid' } };
                }
                db.prepare('UPDATE time_entries SET end_time = ? WHERE id = ? AND api_key_id = ?')
                    .run(newPreviousEnd, previousEntryId, req.apiKeyId);
            }

            db.prepare('UPDATE time_entries SET start_time = ? WHERE id = ? AND api_key_id = ?')
                .run(newStart, entryId, req.apiKeyId);

            return { newStart };
        });

        const result = applyShift();
        if (result.error) {
            return res.status(result.error.code).json({ error: result.error.message });
        }

        broadcastUpdate(req.apiKey, 'time_entry_updated', { id: entryId, start_time: result.newStart });
        if (previousEntryId) {
            broadcastUpdate(req.apiKey, 'time_entry_updated', { id: previousEntryId });
        }
        res.json({ success: true, start_time: result.newStart });
    } catch (error) {
        console.error('Error shifting time entry start:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update an entry and optionally linked neighboring boundaries in one transaction
app.put('/api/time-entries/:id/edit-linked', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
        const { start_time, end_time, next_entry_id, previous_entry_id } = req.body;
        const hasNextEntryId = next_entry_id !== undefined && next_entry_id !== null && next_entry_id !== '';
        const hasPreviousEntryId = previous_entry_id !== undefined && previous_entry_id !== null && previous_entry_id !== '';
        const nextEntryId = hasNextEntryId ? parseInt(next_entry_id) : null;
        const previousEntryId = hasPreviousEntryId ? parseInt(previous_entry_id) : null;

        if (!Number.isInteger(entryId)) {
            return res.status(400).json({ error: 'Invalid time entry id' });
        }
        if (!start_time) {
            return res.status(400).json({ error: 'start_time is required' });
        }
        if (hasNextEntryId && !Number.isInteger(nextEntryId)) {
            return res.status(400).json({ error: 'next_entry_id must be a valid integer' });
        }
        if (hasPreviousEntryId && !Number.isInteger(previousEntryId)) {
            return res.status(400).json({ error: 'previous_entry_id must be a valid integer' });
        }

        const newStart = new Date(start_time);
        const newEnd = end_time ? new Date(end_time) : null;
        if (isNaN(newStart.getTime()) || (end_time && (!newEnd || isNaN(newEnd.getTime())))) {
            return res.status(400).json({ error: 'start_time/end_time must be valid ISO date strings' });
        }
        if (newEnd && newStart >= newEnd) {
            return res.status(400).json({ error: 'start_time must be before end_time' });
        }

        const applyEdit = db.transaction(() => {
            const getEntry = db.prepare('SELECT id, start_time, end_time FROM time_entries WHERE id = ? AND api_key_id = ?');
            const current = getEntry.get(entryId, req.apiKeyId);
            if (!current) {
                return { error: { code: 404, message: 'Time entry not found' } };
            }

            const normalizedStart = newStart.toISOString();
            const normalizedEnd = newEnd ? newEnd.toISOString() : null;
            const startChanged = normalizedStart !== current.start_time;
            const endChanged = normalizedEnd !== current.end_time;

            if (nextEntryId && startChanged) {
                const nextEntry = getEntry.get(nextEntryId, req.apiKeyId);
                if (!nextEntry) {
                    return { error: { code: 404, message: 'Linked next entry not found' } };
                }
                if (new Date(nextEntry.start_time) >= newStart) {
                    return { error: { code: 400, message: 'Linked next entry would become invalid' } };
                }
                db.prepare('UPDATE time_entries SET end_time = ? WHERE id = ? AND api_key_id = ?')
                    .run(normalizedStart, nextEntryId, req.apiKeyId);
            }

            if (previousEntryId && endChanged && normalizedEnd) {
                const previousEntry = getEntry.get(previousEntryId, req.apiKeyId);
                if (!previousEntry) {
                    return { error: { code: 404, message: 'Linked previous entry not found' } };
                }
                if (!previousEntry.end_time) {
                    return { error: { code: 400, message: 'Linked previous entry must be completed' } };
                }
                if (newEnd >= new Date(previousEntry.end_time)) {
                    return { error: { code: 400, message: 'Linked previous entry would become invalid' } };
                }
                db.prepare('UPDATE time_entries SET start_time = ? WHERE id = ? AND api_key_id = ?')
                    .run(normalizedEnd, previousEntryId, req.apiKeyId);
            }

            db.prepare('UPDATE time_entries SET start_time = ?, end_time = ? WHERE id = ? AND api_key_id = ?')
                .run(normalizedStart, normalizedEnd, entryId, req.apiKeyId);

            return { normalizedStart, normalizedEnd };
        });

        const result = applyEdit();
        if (result.error) {
            return res.status(result.error.code).json({ error: result.error.message });
        }

        broadcastUpdate(req.apiKey, 'time_entry_updated', { id: entryId, start_time: result.normalizedStart, end_time: result.normalizedEnd });
        if (nextEntryId) {
            broadcastUpdate(req.apiKey, 'time_entry_updated', { id: nextEntryId });
        }
        if (previousEntryId) {
            broadcastUpdate(req.apiKey, 'time_entry_updated', { id: previousEntryId });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating linked time entries:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a time entry
app.delete('/api/time-entries/:id', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
        if (!Number.isInteger(entryId)) {
            return res.status(400).json({ error: 'Invalid time entry id' });
        }
        const stmt = db.prepare('DELETE FROM time_entries WHERE id = ? AND api_key_id = ?');
        const result = stmt.run(entryId, req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found' });
        }
        broadcastUpdate(req.apiKey, 'time_entry_deleted', { id: entryId });
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: Generate new API key
app.post('/api/admin/keys', requireAdminPassword, (req, res) => {
    try {
        const { name } = req.body;
        const apiKey = crypto.randomBytes(32).toString('hex');
        const stmt = db.prepare('INSERT INTO api_keys (api_key, name) VALUES (?, ?)');
        const result = stmt.run(apiKey, name || null);
        res.json({ id: result.lastInsertRowid, api_key: apiKey, name: name || null });
    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: List all API keys
app.get('/api/admin/keys', requireAdminPassword, (req, res) => {
    try {
        const stmt = db.prepare('SELECT id, api_key, name, created_at FROM api_keys ORDER BY created_at DESC');
        const keys = stmt.all();
        res.json(keys);
    } catch (error) {
        console.error('Error listing API keys:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: Update API key name
app.put('/api/admin/keys/:id', requireAdminPassword, (req, res) => {
    try {
        const { name } = req.body;
        const stmt = db.prepare('UPDATE api_keys SET name = ? WHERE id = ?');
        const result = stmt.run(name || null, parseInt(req.params.id));
        if (result.changes === 0) {
            return res.status(404).json({ error: 'API key not found' });
        }
        res.json({ success: true, name: name || null });
    } catch (error) {
        console.error('Error updating API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: Delete API key
app.delete('/api/admin/keys/:id', requireAdminPassword, (req, res) => {
    try {
        const stmt = db.prepare('DELETE FROM api_keys WHERE id = ?');
        const result = stmt.run(parseInt(req.params.id));
        if (result.changes === 0) {
            return res.status(404).json({ error: 'API key not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route - serve HTML page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Legacy admin route - serve HTML page
app.get('/api', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
