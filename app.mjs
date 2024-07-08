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

function parseProjects(projects) {
    return projects
        .filter(project => project.name.includes('/'))
        .map(project => {
            const [name, targetTime] = project.name.split('/');
            return {
                id: project.id,
                name: name,
                targetTime: parseInt(targetTime, 10)
            };
        })
        .sort((a, b) => b.targetTime - a.targetTime);
}

const getProjects = memoize(async (apiToken, workspaceId) => {
    const response = await fetch(`https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/projects`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
        }
    });
    const data = await response.json();
    return parseProjects(data);
});

app.post('/getProjects', async (req, res) => {
    const { apiToken, workspaceId } = req.body;
    try {
        const projects = await getProjects(apiToken, workspaceId);
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function getTimeEntries(apiToken) {
    // get unix timestamp for this time one week ago
    const now = new Date();
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    // const since = Math.floor(oneWeekAgo.getTime() / 1000);
    const start_date = oneWeekAgo.toISOString();
    const end_date = now.toISOString();
    
    const response = await fetch(`https://api.track.toggl.com/api/v9/me/time_entries?start_date=${start_date}&end_date=${end_date}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${apiToken}:api_token`).toString('base64')
        }
    });
    const data = await response.json();
    return data;
}

function calculateTotalTimes(events) {
    let totalHours = 0;
    let projectTimes = {};

    events.forEach(event => {
        let duration = event.duration;
        if (duration < 0) {
            const start = new Date(event.start);
            duration = (new Date().getTime() - start.getTime()) / 1000;
        }
        let durationHours = duration / 3600;
        totalHours += durationHours;
        if (projectTimes[event.project_id]) {
            projectTimes[event.project_id] += durationHours;
        } else {
            projectTimes[event.project_id] = durationHours;
        }
    });

    return {
        total: totalHours,
        projects: projectTimes
    };
}

async function getProjectId(apiToken, workspaceId, projectName) {
    const data = await getProjects(apiToken, workspaceId)
    const project = data.find(p => p.name === projectName);
    return project.id;
}

async function getProjectName(apiToken, workspaceId, projectId) {
    const data = await getProjects(apiToken, workspaceId);
    const project = data.find(p => p.id == projectId);
    return project ? project.name : null;
}

app.post('/getTimeTotals', async (req, res) => {
    const { apiToken, workspaceId } = req.body;
    try {
        const timeEntries = await getTimeEntries(apiToken);
        const totalTimes = calculateTotalTimes(timeEntries);
        const byProjectId = totalTimes.projects;
        const byProjectName = {};
        for (let projectId in byProjectId) {
            const projectName = await getProjectName(apiToken, workspaceId, projectId);
            byProjectName[projectName] = byProjectId[projectId];
        }
        res.json({
            total: totalTimes.total,
            projects: byProjectName
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } 
})

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