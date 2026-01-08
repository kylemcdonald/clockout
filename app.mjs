import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

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
        
        const colors = ['#D15540', '#9E9A2F', '#D88045', '#D7524E', '#3fc30f', '#5EB868', '#439D43', '#9F509F'];
        const projectColor = color || colors[Math.floor(Math.random() * colors.length)];
        
        const stmt = db.prepare('INSERT INTO projects (api_key_id, name, target_hours, color) VALUES (?, ?, ?, ?)');
        const result = stmt.run(req.apiKeyId, name, parseFloat(target_hours), projectColor);
        res.json({ id: result.lastInsertRowid, name, target_hours: parseFloat(target_hours), color: projectColor, visible: 1 });
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
        res.json(project);
    } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: 'Project with this name already exists' });
        }
        console.error('Error updating project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a project
app.delete('/api/projects/:id', requireApiKey, (req, res) => {
    try {
        const stmt = db.prepare('DELETE FROM projects WHERE id = ? AND api_key_id = ?');
        const result = stmt.run(parseInt(req.params.id), req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get current running time entry
app.get('/api/time-entries/current', requireApiKey, (req, res) => {
    try {
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

// Get time entries for the last week
app.get('/api/time-entries', requireApiKey, (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT te.id, te.project_id, te.start_time, te.end_time, p.name as project_name
            FROM time_entries te
            JOIN projects p ON te.project_id = p.id
            WHERE te.api_key_id = ?
            ORDER BY te.start_time DESC
        `);
        const entries = stmt.all(req.apiKeyId);
        
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

// Start a new time entry
app.post('/api/time-entries', requireApiKey, (req, res) => {
    try {
        const { project_id } = req.body;
        if (!project_id) {
            return res.status(400).json({ error: 'project_id is required' });
        }
        
        // Verify project belongs to this API key
        const projectStmt = db.prepare('SELECT id, name FROM projects WHERE id = ? AND api_key_id = ?');
        const project = projectStmt.get(parseInt(project_id), req.apiKeyId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        // Stop any currently running time entry
        const stopStmt = db.prepare('UPDATE time_entries SET end_time = ? WHERE api_key_id = ? AND end_time IS NULL');
        stopStmt.run(new Date().toISOString(), req.apiKeyId);
        
        // Start new time entry
        const startTime = new Date().toISOString();
        const insertStmt = db.prepare('INSERT INTO time_entries (api_key_id, project_id, start_time) VALUES (?, ?, ?)');
        const result = insertStmt.run(req.apiKeyId, parseInt(project_id), startTime);
        
        res.json({
            id: result.lastInsertRowid,
            project_id: parseInt(project_id),
            start: startTime,
            stop: null,
            name: project.name
        });
    } catch (error) {
        console.error('Error starting time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop current time entry
app.patch('/api/time-entries/:id/stop', requireApiKey, (req, res) => {
    try {
        const stmt = db.prepare('UPDATE time_entries SET end_time = ? WHERE id = ? AND api_key_id = ? AND end_time IS NULL');
        const result = stmt.run(new Date().toISOString(), parseInt(req.params.id), req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found or already stopped' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error stopping time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a time entry (start_time and/or end_time)
app.put('/api/time-entries/:id', requireApiKey, (req, res) => {
    try {
        const { start_time, end_time } = req.body;

        // Validate input
        if (!start_time && end_time === undefined) {
            return res.status(400).json({ error: 'Either start_time or end_time must be provided' });
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

        // Add WHERE conditions
        params.push(parseInt(req.params.id), req.apiKeyId);

        const stmt = db.prepare(`UPDATE time_entries SET ${updates.join(', ')} WHERE id = ? AND api_key_id = ?`);
        const result = stmt.run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a time entry
app.delete('/api/time-entries/:id', requireApiKey, (req, res) => {
    try {
        const stmt = db.prepare('DELETE FROM time_entries WHERE id = ? AND api_key_id = ?');
        const result = stmt.run(parseInt(req.params.id), req.apiKeyId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Time entry not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting time entry:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: Generate new API key
app.post('/api/admin/keys', requireAdminPassword, (req, res) => {
    try {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const stmt = db.prepare('INSERT INTO api_keys (api_key) VALUES (?)');
        const result = stmt.run(apiKey);
        res.json({ id: result.lastInsertRowid, api_key: apiKey });
    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin route: List all API keys
app.get('/api/admin/keys', requireAdminPassword, (req, res) => {
    try {
        const stmt = db.prepare('SELECT id, api_key, created_at FROM api_keys ORDER BY created_at DESC');
        const keys = stmt.all();
        res.json(keys);
    } catch (error) {
        console.error('Error listing API keys:', error);
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

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
