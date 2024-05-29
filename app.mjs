import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function memoize(func) {
    const cache = {};
    return async function(...args) {
        const key = JSON.stringify(args);
        if (cache[key]) {
            return cache[key];
        }
        const result = await func(...args);
        cache[key] = result;
        return result;
    };
}

const getProjects = memoize(async (apiToken, workspaceId) => {
    const response = await fetch(`https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/projects`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
        }
    });
    const data = await response.json();
    return data;
})

async function getProjectId(apiToken, workspaceId, projectName) {
    const data = await getProjects(apiToken, workspaceId)
    const project = data.find(p => p.name === projectName);
    return project.id;
}

async function getProjectName(apiToken, workspaceId, projectId) {
    const data = await getProjects(apiToken, workspaceId)
    const project = data.find(p => p.id === projectId);
    return project.name;
}

app.post('/getCurrentTask', async (req, res) => {
    const { apiToken, workspaceId } = req.body;
    try {
        const response = await fetch(`https://api.track.toggl.com/api/v9/me/time_entries/current`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
            }
        });
        const data = await response.json();
        data.name = await getProjectName(apiToken, workspaceId, data.project_id);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } 
})

app.post('/currentTask', async (req, res) => {
    const { apiToken, workspaceId, taskName } = req.body;
    try {
        const projectId = await getProjectId(apiToken, workspaceId, taskName);
        const response = await fetch(`https://api.track.toggl.com/api/v9/me/time_entries/current`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
            },
            body: JSON.stringify({
                created_with: 'iPad',
                tags: [],
                project_id: parseInt(projectId),
                billable: false,
                workspace_id: parseInt(workspaceId),
                duration: -1,
                start: new Date().toISOString(),
                stop: null
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } 
})

app.post('/startTask', async (req, res) => {
    const { apiToken, workspaceId, taskName } = req.body;
    try {
        const projectId = await getProjectId(apiToken, workspaceId, taskName);
        const response = await fetch(`https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
            },
            body: JSON.stringify({
                created_with: 'iPad',
                tags: [],
                project_id: parseInt(projectId),
                billable: false,
                workspace_id: parseInt(workspaceId),
                duration: -1,
                start: new Date().toISOString(),
                stop: null
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/stopTask', async (req, res) => {
    const { apiToken, workspaceId, taskId } = req.body;
    try {
        await fetch(`https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries/${taskId}/stop`, {
            method: 'PATCH',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
            }
        });
        res.sendStatus(200);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});