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

// Helper function to get API key from request
function getApiKey(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    return req.headers['x-api-key'] || req.query.api_key || req.body.api_key;
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

// Helper function to clean up stale running entries (keeps only the most recent)
function cleanupStaleRunningEntries(apiKeyId) {
    const allRunningStmt = db.prepare(`
        SELECT te.id, te.start_time
        FROM time_entries te
        WHERE te.api_key_id = ? AND te.end_time IS NULL
        ORDER BY te.start_time DESC
    `);
    const runningEntries = allRunningStmt.all(apiKeyId);

    if (runningEntries.length > 1) {
        const mostRecentId = runningEntries[0].id;
        const staleIds = runningEntries.slice(1).map(e => e.id);
        const stopStaleStmt = db.prepare(`
            UPDATE time_entries SET end_time = start_time
            WHERE id IN (${staleIds.map(() => '?').join(',')}) AND end_time IS NULL
        `);
        stopStaleStmt.run(...staleIds);
        console.log(`Cleaned up ${staleIds.length} stale running entries, keeping entry ${mostRecentId}`);
        return staleIds.length;
    }
    return 0;
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
        
        const colors = ['#f94144', '#f3722c', '#f8961e', '#f9844a', '#f9c74f', '#90be6d', '#43aa8b', '#4d908e', '#577590', '#277da1'];
        const projectColor = color || colors[Math.floor(Math.random() * colors.length)];
        
        const stmt = db.prepare('INSERT INTO projects (api_key_id, name, target_hours, color) VALUES (?, ?, ?, ?)');
        const result = stmt.run(req.apiKeyId, name, parseFloat(target_hours), projectColor);
        const newProject = { id: result.lastInsertRowid, name, target_hours: parseFloat(target_hours), color: projectColor, visible: 1 };
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
        const { name, target_hours, visible } = req.body;
        if (!name || target_hours === undefined) {
            return res.status(400).json({ error: 'Name and target_hours are required' });
        }
        
        let query = 'UPDATE projects SET name = ?, target_hours = ?';
        const params = [name, parseFloat(target_hours)];
        
        if (visible !== undefined) {
            query += ', visible = ?';
            params.push(visible ? 1 : 0);
        }
        
        query += ' WHERE id = ? AND api_key_id = ?';
        params.push(parseInt(req.params.id), req.apiKeyId);
        
        const stmt = db.prepare(query);
        const result = stmt.run(...params);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        // Fetch updated project
        const getStmt = db.prepare('SELECT id, name, target_hours, color, visible FROM projects WHERE id = ?');
        const project = getStmt.get(parseInt(req.params.id));
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
        // Clean up any stale running entries first
        cleanupStaleRunningEntries(req.apiKeyId);

        // Get the current running entry (should be at most one after cleanup)
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
        // Clean up any stale running entries first
        cleanupStaleRunningEntries(req.apiKeyId);

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

        // Verify project belongs to this API key
        const projectStmt = db.prepare('SELECT id, name FROM projects WHERE id = ? AND api_key_id = ?');
        const project = projectStmt.get(parseInt(project_id), req.apiKeyId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // If both start_time and end_time provided, create a completed entry directly
        if (start_time && end_time) {
            const insertStmt = db.prepare('INSERT INTO time_entries (api_key_id, project_id, start_time, end_time) VALUES (?, ?, ?, ?)');
            const result = insertStmt.run(req.apiKeyId, parseInt(project_id), start_time, end_time);
            const newEntry = {
                id: result.lastInsertRowid,
                project_id: parseInt(project_id),
                start: start_time,
                stop: end_time,
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

        const newEntryId = startNewEntry(req.apiKeyId, parseInt(project_id), startTime);

        const newEntry = {
            id: newEntryId,
            project_id: parseInt(project_id),
            start: startTime,
            stop: null,
            name: project.name
        };
        broadcastUpdate(req.apiKey, 'time_entry_started', newEntry);
        res.json(newEntry);
    } catch (error) {
        console.error('Error starting time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop current time entry
app.patch('/api/time-entries/:id/stop', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
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

        // Validate input
        if (!start_time && end_time === undefined && !project_id) {
            return res.status(400).json({ error: 'Either start_time, end_time, or project_id must be provided' });
        }

        // Validate project_id if provided
        if (project_id) {
            const projectStmt = db.prepare('SELECT id FROM projects WHERE id = ? AND api_key_id = ?');
            const project = projectStmt.get(parseInt(project_id), req.apiKeyId);
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

        // If both start and end are provided, ensure start is before end
        if (validatedStartTime && validatedEndTime && new Date(validatedStartTime) >= new Date(validatedEndTime)) {
            return res.status(400).json({ error: 'start_time must be before end_time' });
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
            params.push(parseInt(project_id));
        }

        // Add WHERE conditions
        params.push(parseInt(req.params.id), req.apiKeyId);

        const stmt = db.prepare(`UPDATE time_entries SET ${updates.join(', ')} WHERE id = ? AND api_key_id = ?`);
        const result = stmt.run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found' });
        }

        const entryId = parseInt(req.params.id);
        broadcastUpdate(req.apiKey, 'time_entry_updated', { id: entryId, start_time: validatedStartTime, end_time: validatedEndTime });
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a time entry
app.delete('/api/time-entries/:id', requireApiKey, (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
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

// History route - serve HTML page
app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

// Settings route - serve HTML page
app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
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
