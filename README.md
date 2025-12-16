# Clock-Out Time Tracking App

A self-hosted time tracking application with SQLite backend for managing projects and time entries.

## Architecture

This application uses a SQLite database to store all data locally, with no external API dependencies.

### Frontend (Client-Side)
- **Location**: `public/index.html`
- **Technology**: Vanilla HTML/CSS/JavaScript
- **Features**:
  - Project progress visualization
  - Real-time time tracking
  - Settings modal for API key and project management
  - History view for time entries

### Backend (Server-Side)
- **Location**: `app.mjs`
- **Technology**: Express.js with SQLite (better-sqlite3)
- **Database**: SQLite (`clockout.db`)
- **Features**:
  - API key authentication
  - Project management
  - Time entry tracking
  - Admin interface for API key management

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser to `http://localhost:3000`

## Database Schema

The application uses SQLite with three main tables:

- **api_keys**: Stores API keys for user authentication
- **projects**: Stores project names, target hours, and colors
- **time_entries**: Stores time tracking entries with start/end times

## Usage

### Getting Started

1. **Generate an API Key**:
   - Navigate to `/api` (password-protected admin interface)
   - Enter the admin password (default: `admin123`, set via `ADMIN_PASSWORD` environment variable)
   - Click "Generate New API Key"
   - Copy the generated API key

2. **Configure Your Account**:
   - Click the settings button (⚙️) in the top-right corner
   - Enter your API key
   - Add projects with names and target hours
   - Click "Save API Key"

3. **Track Time**:
   - Click on any project to start tracking time
   - Click the same project again to stop tracking
   - The app updates automatically every minute

4. **View History**:
   - Navigate to `/history` to see all time entries for the last week

### Settings Modal

The settings modal (⚙️ button) allows you to:
- View and update your API key
- Add new projects with target hours
- Delete existing projects

### Admin Interface

The admin interface (`/api`) allows you to:
- Generate new API keys
- View all API keys
- Delete API keys (this also deletes associated projects and time entries)

**Default Admin Password**: `admin123`

To change the admin password, set the `ADMIN_PASSWORD` environment variable:
```bash
ADMIN_PASSWORD=your-secure-password npm start
```

## API Endpoints

### Public Endpoints
- `GET /` - Main dashboard
- `GET /history` - Time entry history page
- `GET /api` - Admin interface

### Authenticated Endpoints (require API key)
- `GET /api/projects` - Get user's projects
- `POST /api/projects` - Add a new project
- `DELETE /api/projects/:id` - Delete a project
- `GET /api/time-entries` - Get time entries (last week)
- `GET /api/time-entries/current` - Get currently running time entry
- `POST /api/time-entries` - Start a new time entry
- `PATCH /api/time-entries/:id/stop` - Stop a time entry

### Admin Endpoints (require admin password)
- `GET /api/admin/keys` - List all API keys
- `POST /api/admin/keys` - Generate new API key
- `DELETE /api/admin/keys/:id` - Delete an API key

## Features

- **Multi-User Support**: Each API key represents a separate user
- **Project Management**: Add projects with custom target hours
- **Real-time Tracking**: Visual progress bars update in real-time
- **Time History**: View all time entries for the past week
- **Offline Capability**: All data stored locally in SQLite
- **Responsive Design**: Works on desktop and mobile devices

## Technical Details

### Authentication
- API keys are sent via `Authorization: Bearer <key>` header or `X-API-Key` header
- Admin routes require password via `X-Admin-Password` header

### Data Storage
- All data is stored in `clockout.db` SQLite database
- Database is created automatically on first run
- Foreign key constraints ensure data integrity

## Environment Variables

- `PORT` - Server port (default: 3000)
- `ADMIN_PASSWORD` - Password for admin interface (default: `admin123`)
