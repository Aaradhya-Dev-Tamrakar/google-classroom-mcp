# Google Classroom Model Context Protocol (MCP) Server

A native, lightweight **Model Context Protocol (MCP)** server for Google Classroom. Allows AI assistants (such as Antigravity, Claude, and LLM orchestration meshes) to query, inspect, and interact with Google Classroom courses, coursework, assignments, announcements, student submissions, and rosters.

---

## Features & Tools

| Tool | Description |
| :--- | :--- |
| `list_courses` | List enrolled or taught courses (`ACTIVE`, `ARCHIVED`, etc.). |
| `get_course` | Retrieve detailed metadata for a specific course by ID. |
| `list_coursework` | Query assignments, quizzes, due dates, and point values. |
| `get_coursework` | Get assignment instructions, attached Drive files, YouTube links, and rubrics. |
| `list_submissions` | Check submission statuses (`TURNED_IN`, `RETURNED`, `NEW`), late flags, and grades. |
| `get_submission` | View specific student submission attachments and details. |
| `list_announcements` | Fetch stream announcements, updates, and materials. |
| `list_coursework_materials` | List reference materials, syllabi, and shared files. |
| `list_teachers` | List course instructors. |
| `list_students` | List enrolled students in a course. |
| `turn_in_assignment` | Submit student coursework. |
| `reclaim_assignment` | Unsubmit student coursework. |

---

## Prerequisites

1. **Google Cloud Project**:
   - Enable the **Google Classroom API** (`classroom.googleapis.com`).
   - Create an **OAuth 2.0 Client ID** (Type: *Desktop App*).
   - Save the downloaded JSON file as `.classroom-credentials.json` (or set `CLASSROOM_OAUTH_PATH`).

2. **Node.js**:
   - Node.js v18+ is required.

---

## Installation & Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Authenticate with Google**:
   ```bash
   npm run auth
   ```
   *A browser window will open asking for approval. After granting consent, tokens are securely saved locally to `.classroom-server-credentials.json`.*

3. **Sync MCP Schemas**:
   ```bash
   npm run sync
   ```
   *Generates tool definition schemas for lazy-loading MCP clients.*

---

## Configuration

### In Antigravity / Claude Desktop

Add the following entry to your `mcp_config.json`:

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

## License

MIT