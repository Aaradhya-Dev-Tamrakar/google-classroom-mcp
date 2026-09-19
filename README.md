# Google Classroom Model Context Protocol (MCP) Server

[![Ecosystem](https://img.shields.io/badge/Orchestration-Antigravity%20%2F%20Claude%20Fleet-7952b3)](https://github.com/Aaradhya-Dev-Tamrakar/brainstorm)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Node.js%20ESM-informational)](https://nodejs.org)

A native, lightweight, and robust **Model Context Protocol (MCP)** server for the Google Classroom API. It connects LLM reasoning engines (Antigravity, Claude Desktop, and autonomous fleet agents) directly to Google Classroom streams, assignments, submissions, rosters, and educational resources.

---

## 🏗 Architecture & Flow

```
┌─────────────────────────────────────────────────────────┐
│     Antigravity / Claude Desktop (MCP Client)           │
└───────────────────────────┬─────────────────────────────┘
                            │ JSON-RPC (Stdio)
┌───────────────────────────▼─────────────────────────────┐
│               google-classroom-mcp                      │
│  - index.mjs            (MCP Protocol Dispatcher)       │
│  - auth.mjs             (OAuth 2.0 Loopback Receiver)   │
│  - sync-schemas.mjs     (Lazy Tool Schema Generator)    │
│  - sync.ps1             (Ecosystem Sync & Secret Guard) │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS REST with Auto Token Refresh
┌───────────────────────────▼─────────────────────────────┐
│     Google Classroom REST API (v1)                      │
│     https://classroom.googleapis.com/v1/...             │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠 Available Tools & Implementation Methods

The server implements 12 high-agency tools conforming to `@modelcontextprotocol/sdk`:

### 1. `list_courses`
* **Method**: `GET https://classroom.googleapis.com/v1/courses`
* **Parameters**:
  - `courseStates` *(array of strings, optional)*: Filter by status (`ACTIVE`, `ARCHIVED`, `PROVISIONED`, `DECLINED`, `SUSPENDED`). Defaults to `['ACTIVE']`.
  - `pageSize` *(number, optional)*: Maximum items to return (default 20).
  - `studentId` *(string, optional)*: Filter courses enrolled as student (`"me"` or user ID).
  - `teacherId` *(string, optional)*: Filter courses instructed as teacher (`"me"` or user ID).
* **Returns**: Markdown list of matching courses with ID, name, section, room, enrollment code, and web link.

### 2. `get_course`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}`
* **Parameters**:
  - `courseId` *(string, required)*: Unique Google Classroom course identifier.
* **Returns**: Full course object schema including enrollment code, description, teacher group email, and calendar ID.

### 3. `list_coursework`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork`
* **Parameters**:
  - `courseId` *(string, required)*: Target course identifier.
  - `courseWorkStates` *(array of strings, optional)*: Filter (`PUBLISHED`, `DRAFT`, `DELETED`).
  - `pageSize` *(number, optional)*: Maximum assignments to fetch (default 30).
  - `orderBy` *(string, optional)*: Order criteria (`dueDate desc`, `updateTime desc`).
* **Returns**: Formatted summary of assignments, problem sets, due dates/times, max points, and links.

### 4. `get_coursework`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/{courseWorkId}`
* **Parameters**:
  - `courseId` *(string, required)*: Course identifier.
  - `courseWorkId` *(string, required)*: Coursework item identifier.
* **Returns**: Complete assignment metadata, instructions, rubrics, and attached materials (Google Drive files, YouTube videos, links).

### 5. `list_submissions`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions`
* **Parameters**:
  - `courseId` *(string, required)*: Course identifier.
  - `courseWorkId` *(string, required)*: Coursework item ID (or `"-"` for all coursework).
  - `userId` *(string, optional)*: Target student filter (`"me"` for current authenticated student).
  - `states` *(array of strings, optional)*: Filter (`NEW`, `CREATED`, `TURNED_IN`, `RETURNED`, `RECLAIMED_BY_STUDENT`).
* **Returns**: Student submission states, lateness flags, assigned grades, draft grades, and turn-in links.

### 6. `get_submission`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions/{submissionId}`
* **Parameters**:
  - `courseId` *(string, required)*
  - `courseWorkId` *(string, required)*
  - `submissionId` *(string, required)*
* **Returns**: Detailed submission record with attached student drive files, links, and grade history.

### 7. `list_announcements`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/announcements`
* **Parameters**:
  - `courseId` *(string, required)*: Course identifier.
  - `announcementStates` *(array of strings, optional)*: Filter (`PUBLISHED`, `DRAFT`, `DELETED`).
  - `pageSize` *(number, optional)*: Max announcements (default 20).
* **Returns**: Course stream announcements, updates, creator info, timestamps, and attached assets.

### 8. `list_coursework_materials`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWorkMaterials`
* **Parameters**:
  - `courseId` *(string, required)*: Course identifier.
  - `courseWorkMaterialStates` *(array of strings, optional)*: Defaults to `['PUBLISHED']`.
* **Returns**: Standalone class resources, lecture slide decks, syllabus documents, and shared materials.

### 9. `list_teachers`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/teachers`
* **Parameters**:
  - `courseId` *(string, required)*
* **Returns**: List of instructors with display name, email, and user IDs.

### 10. `list_students`
* **Method**: `GET https://classroom.googleapis.com/v1/courses/{courseId}/students`
* **Parameters**:
  - `courseId` *(string, required)*
* **Returns**: List of enrolled classmates with display name, email, and user IDs.

### 11. `turn_in_assignment`
* **Method**: `POST https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions/{submissionId}:turnIn`
* **Parameters**:
  - `courseId` *(string, required)*
  - `courseWorkId` *(string, required)*
  - `submissionId` *(string, required)*
* **Returns**: Confirmation that the student submission has been formally marked as turned in for grading.

### 12. `reclaim_assignment`
* **Method**: `POST https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions/{submissionId}:reclaim`
* **Parameters**:
  - `courseId` *(string, required)*
  - `courseWorkId` *(string, required)*
  - `submissionId` *(string, required)*
* **Returns**: Confirmation that the student submission has been unsubmitted/reclaimed for editing.

---

## 🔑 Authentication & Token Lifecycle

1. **Credentials**: Provide standard Google Cloud OAuth 2.0 Client credentials (Desktop Application).
2. **Initial Authorisation (`npm run auth`)**:
   - Launches a local HTTP loopback server on port `58246`.
   - Generates Google OAuth consent URL with offline access (`prompt=consent`).
   - Opens the browser to authorize.
   - Captures authorization code and exchanges it for a permanent `refresh_token` and initial `access_token`.
   - Persists securely to `.classroom-server-credentials.json` (gitignored).
3. **Automated Refreshing**:
   - `index.mjs` checks token expiration before every API request.
   - When remaining validity is `< 60 seconds`, or on receiving HTTP `401 Unauthorized`, it transparently calls `https://oauth2.googleapis.com/token` to refresh the access token.

---

## 🚀 Installation & Setup

```bash
# 1. Clone repository
git clone https://github.com/Aaradhya-Dev-Tamrakar/google-classroom-mcp.git
cd google-classroom-mcp

# 2. Install dependencies
npm install

# 3. Authenticate with Google Classroom
npm run auth

# 4. Generate Antigravity tool schemas
npm run sync
```

---

## ⚙️ Configuration

### Antigravity & Claude Desktop Registration

Add this server block to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "classroom": {
      "command": "node",
      "args": [
        "F:\\Aaradhya-Dev-Tamrakar\\google-classroom-mcp\\index.mjs"
      ],
      "env": {
        "CLASSROOM_CREDENTIALS_PATH": "C:\\Users\\Aaradhya\\.classroom-server-credentials.json",
        "CLASSROOM_OAUTH_PATH": "C:\\Users\\Aaradhya\\.classroom-credentials.json"
      }
    }
  }
}
```

---

## 🔄 Synchronization & Maintenance (`sync.ps1`)

This repository follows the centralized ecosystem Git and secret governance standard:

```powershell
# Routine synchronization & rebase push:
.\sync.ps1

# Custom semantic commit message:
.\sync.ps1 -m "feat(classroom): add rubric parsing support"

# Refresh Antigravity schemas before pushing:
.\sync.ps1 -SyncSchemas

# Dry-run inspection (runs secret scanner without touching git state):
.\sync.ps1 -WhatIf

# Safe pull only:
.\sync.ps1 -PullOnly
```

### Safety Features
- **Secret Scanner Guard**: Blocks commits if OAuth credentials, tokens, private keys, or API secrets are staged.
- **Atomic conventional commit formatting**: Autodetects added/modified files and formats clean commit prefixes.
- **Rebase-safety**: Always executes `git pull --rebase --autostash` before pushing to avoid merge bubbles.

---

## 📄 License

MIT License. Developed for Aaradhya's Personal Tool Ecosystem.