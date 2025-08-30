# Toggl Time Tracking App

A time tracking application that integrates with Toggl Track API to display project progress and manage time entries.

## Architecture

This application has been refactored to move all business logic to the frontend, with the backend serving only as a CORS proxy.

### Frontend (Client-Side)
- **Location**: `public/index.html`
- **Technology**: Vanilla HTML/CSS/JavaScript
- **Features**:
  - All API calls to Toggl Track API
  - Data processing and calculations
  - Project parsing and time calculations
  - Memoization for performance
  - Real-time updates every minute

### Backend (Server-Side)
- **Location**: `app.mjs` (or `app-simple.mjs`)
- **Technology**: Express.js with proxy middleware
- **Purpose**: CORS proxy only
- **Endpoint**: `/proxy` - forwards requests to Toggl API

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server (choose one option):

   **Option A: Using http-proxy-middleware (Recommended)**
   ```bash
   npm start
   ```

   **Option B: Using simple CORS proxy**
   ```bash
   npm run start:simple
   ```

3. Open your browser to `http://localhost:3000`

## Proxy Options

### Option A: http-proxy-middleware (`app.mjs`)
- **Pros**: More robust, better error handling, optimized for proxying
- **Cons**: Slightly more complex setup
- **Best for**: Production environments

### Option B: Simple CORS proxy (`app-simple.mjs`)
- **Pros**: Minimal code, easy to understand, fewer dependencies
- **Cons**: Less error handling, manual request forwarding
- **Best for**: Development, simple use cases

## Usage

1. Click the "Login" button in the top-right corner
2. Enter your Toggl API token
3. The app will display your projects with progress bars
4. Click on any project to start tracking time
5. The app updates automatically every minute

## API Token

To get your Toggl API token:
1. Log in to your Toggl account
2. Go to Profile Settings
3. Scroll down to "API Token"
4. Copy the token and paste it in the app

## Project Structure

Projects should be named in the format: `ProjectName/TargetHours`
Example: `Work/40`, `Exercise/5`, `Reading/10`

The app will automatically parse these names and display progress bars based on the target hours.

## Features

- **Real-time Updates**: Automatically refreshes every minute
- **Progress Visualization**: Visual progress bars for each project
- **Time Tracking**: Start/stop time tracking for projects
- **Untracked Time**: Shows remaining untracked hours in a week
- **Responsive Design**: Works on desktop and mobile devices
- **Offline Capability**: Caches data locally for better performance

## Technical Details

### Frontend Functions
- `memoize()`: Client-side caching for API responses
- `parseProjects()`: Parses project names and target hours
- `calculateTotalTimes()`: Calculates time totals from API data
- `getProjects()`, `getTimeEntries()`: API calls to Toggl
- `updateTotals()`, `updateUntrackedTime()`: UI update functions

### Backend Proxy Options
- **http-proxy-middleware**: Handles CORS issues with Toggl API, forwards all HTTP methods, preserves headers and request bodies
- **Simple CORS proxy**: Basic request forwarding with CORS headers

## Benefits of This Architecture

1. **Simplified Deployment**: Minimal server requirements
2. **Better Performance**: Direct API calls, reduced server load
3. **Easier Maintenance**: Single codebase for business logic
4. **Offline Capability**: Can cache data locally
5. **Reduced Infrastructure**: Lower server costs
6. **Flexible Proxy Options**: Choose between robust or simple proxy implementation
