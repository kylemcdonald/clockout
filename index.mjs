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

async function getProjectId(apiToken, workspaceId, taskName) {
    const response = await fetch(`https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/projects`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
        }
    });
    const data = await response.json();
    const project = data.find(p => p.name === taskName);
    return project.id;
}

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
        res.status(500).json({ error: 'Failed to start task' });
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
        res.status(500).json({ error: 'Failed to stop task' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});