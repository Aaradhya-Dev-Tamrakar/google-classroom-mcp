import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLASSROOM_API = "https://classroom.googleapis.com/v1";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DEFAULT_LEDGER = path.join(process.env.LOCALAPPDATA || os.homedir(), "google-classroom-mcp", "copy-ledger.json");

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function credentials() {
  const root = process.env.USERPROFILE || os.homedir();
  return {
    tokenFile: process.env.DRIVE_CREDENTIALS_PATH || path.join(root, ".gdrive-server-credentials.json"),
    oauthFile: process.env.DRIVE_OAUTH_PATH || path.join(root, ".gdrive-credentials.json"),
  };
}

async function driveToken() {
  const { tokenFile, oauthFile } = credentials();
  if (!fs.existsSync(tokenFile) || !fs.existsSync(oauthFile)) {
    throw new Error("Drive OAuth files are not configured. Set DRIVE_CREDENTIALS_PATH and DRIVE_OAUTH_PATH to the existing Google Drive MCP credential files.");
  }
  const token = readJson(tokenFile);
  if (token.access_token && token.expiry_date > Date.now() + 60_000) return token.access_token;
  const oauth = readJson(oauthFile);
  const keys = oauth.installed || oauth.web;
  if (!token.refresh_token || !keys?.client_id || !keys?.client_secret) throw new Error("Drive credentials do not include a refreshable token and OAuth client.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.client_id, client_secret: keys.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Drive token refresh failed: ${await response.text()}`);
  const fresh = await response.json();
  Object.assign(token, fresh, { expiry_date: Date.now() + fresh.expires_in * 1000 });
  writeJsonAtomic(tokenFile, token);
  return token.access_token;
}

export function createCourseCopier({ classroomFetch, driveFetch = globalThis.fetch, ledgerPath = DEFAULT_LEDGER }) {
  const ledger = readJson(ledgerPath, { copies: {} });
  const checkpoint = () => writeJsonAtomic(ledgerPath, ledger);
  async function classroom(method, route, body) {
    const response = await classroomFetch(`${CLASSROOM_API}${route}`, {
      method, headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Classroom ${response.status} ${method} ${route}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
  async function drive(method, route, body, params = {}) {
    const token = await driveToken();
    const query = new URLSearchParams({ fields: "id,name,mimeType,parents,webViewLink", ...params });
    const response = await driveFetch(`${DRIVE_API}${route}?${query}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Drive ${response.status} ${method} ${route}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
  async function all(route, collection, filters = {}) {
    const items = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ pageSize: "100", ...filters });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await classroom("GET", `${route}?${params}`);
      items.push(...(page[collection] || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }
  return async function copyCourseContents({ sourceCourseId, destinationCourseId, driveFolderId, dryRun = true, pastDueDatePolicy = "skip" }) {
    if (!sourceCourseId || !destinationCourseId || !driveFolderId) throw new Error("sourceCourseId, destinationCourseId, and driveFolderId are required.");
    if (sourceCourseId === destinationCourseId) throw new Error("Source and destination course IDs must differ.");
    if (!["skip", "omit"].includes(pastDueDatePolicy)) throw new Error("pastDueDatePolicy must be 'skip' or 'omit'.");
    const copyKey = `${sourceCourseId}:${destinationCourseId}:${driveFolderId}`;
    ledger.copies[copyKey] ||= { topics: {}, posts: {}, files: {}, folders: {} };
    const state = ledger.copies[copyKey];
    state.failures ||= {};
    const [sourceCourse, destCourse, students, topics, coursework, materials, announcements] = await Promise.all([
      classroom("GET", `/courses/${sourceCourseId}`), classroom("GET", `/courses/${destinationCourseId}`),
      all(`/courses/${destinationCourseId}/students`, "students"),
      all(`/courses/${sourceCourseId}/topics`, "topic"),
      all(`/courses/${sourceCourseId}/courseWork`, "courseWork", { courseWorkStates: "PUBLISHED" }),
      all(`/courses/${sourceCourseId}/courseWorkMaterials`, "courseWorkMaterial", { courseWorkMaterialStates: "PUBLISHED" }),
      all(`/courses/${sourceCourseId}/announcements`, "announcements", { announcementStates: "PUBLISHED" }),
    ]);
    if (sourceCourse.courseState !== "ACTIVE" || destCourse.courseState !== "ACTIVE") throw new Error("Both source and destination courses must be ACTIVE.");
    const published = [...coursework, ...materials, ...announcements];
    const usedTopicIds = new Set(published.map((item) => item.topicId).filter(Boolean));
    const relevantTopics = topics.filter((topic) => usedTopicIds.has(topic.topicId));
    const pastDueItems = coursework.filter((item) => isPastDue(item.dueDate));
    const driveIds = new Set();
    for (const item of published) for (const material of item.materials || []) if (material.driveFile?.driveFile?.id) driveIds.add(material.driveFile.driveFile.id);
    const folders = new Map([["root", driveFolderId]]);
    const folderResponse = await drive("GET", "/files", undefined, {
      q: `'${driveFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id,name,mimeType,parents)",
    }).catch((error) => ({ files: [], _error: error.message }));
    for (const folder of folderResponse.files || []) {
      const week = folder.name.match(/^\[?WK\s*0*(\d+)\]?$/i);
      folders.set(week ? `[WK${Number(week[1])}]` : folder.name, folder.id);
    }
    const plannedFiles = [...driveIds].map((id) => ({ sourceFileId: id, folder: targetFolderName(published, id, topics) }));
    if (dryRun) return {
      dryRun: true, sourceCourse: sourceCourse.name, destinationCourse: destCourse.name,
      destinationStudents: students.length, counts: { topics: relevantTopics.length, coursework: coursework.length, materials: materials.length, announcements: announcements.length, uniqueDriveFiles: driveIds.size },
      files: plannedFiles.map((x) => ({ ...x, destinationFolderId: folders.get(x.folder) || (x.folder === "root" ? driveFolderId : "will be created") })),
      rubricCount: coursework.filter((x) => x.rubrics?.length).length,
      pastDueCoursework: pastDueItems.map((item) => ({ sourceId: item.id, title: item.title, dueDate: item.dueDate })),
      warning: folderResponse._error || undefined,
      note: students.length ? "Destination currently has students; published copies will be visible to them." : "Destination currently has no students.",
    };
    if (students.length) throw new Error(`Destination has ${students.length} student(s). Copy stopped before changes; remove students or confirm a destination with no students.`);
    const noteFailure = (key, failure) => {
      state.failures[key] = failure;
      checkpoint();
    };
    async function ensureFolder(name) {
      if (name === "root") return driveFolderId;
      if (folders.has(name)) return folders.get(name);
      const driveName = name.match(/^\[WK(\d+)\]$/i) ? name.slice(1, -1) : name;
      const created = await drive("POST", "/files", { name: driveName, mimeType: "application/vnd.google-apps.folder", parents: [driveFolderId] });
      folders.set(name, created.id); state.folders[name] = created.id; checkpoint(); return created.id;
    }
    state.rubrics ||= {};
    for (const item of relevantTopics) {
      const key = `topic:${item.topicId || item.name}`;
      if (state.topics[key]) continue;
      try { const created = await classroom("POST", `/courses/${destinationCourseId}/topics`, { name: item.name }); state.topics[key] = created.topicId; checkpoint(); }
      catch (e) { noteFailure(`topic:${item.topicId || item.name}`, { kind: "topic", title: item.name, error: e.message }); }
    }
    for (const id of driveIds) {
      if (state.files[id]) continue;
      let name = "Classroom attachment";
      const folderName = targetFolderName(published, id, topics);
      try {
        const metadata = await drive("GET", `/files/${encodeURIComponent(id)}`);
        name = metadata.name || name;
        const parent = await ensureFolder(folderName);
        const marker = `classroom-copy-${sourceCourseId}-${id}`;
        const existing = await drive("GET", "/files", undefined, {
          q: `'${parent}' in parents and appProperties has { key='classroomCopyKey' and value='${marker}' } and trashed = false`,
          fields: "files(id,name,mimeType,parents)",
        });
        const file = existing.files?.[0] || await drive("POST", `/files/${encodeURIComponent(id)}/copy`, {
          name, parents: [parent], appProperties: { classroomCopyKey: marker },
        });
        state.files[id] = file.id; delete state.failures[`driveFile:${id}`]; checkpoint();
      } catch (e) { noteFailure(`driveFile:${id}`, { kind: "driveFile", sourceFileId: id, name, error: e.message }); }
    }
    const createPost = async (kind, item) => {
      const key = `${kind}:${item.id}`;
      if (state.posts[key]) return;
      const expiredDueDate = kind === "coursework" && isPastDue(item.dueDate);
      if (expiredDueDate && pastDueDatePolicy === "skip") {
        noteFailure(key, { kind, title: item.title, sourceId: item.id, dueDate: item.dueDate, error: "Source due date is in the past; set pastDueDatePolicy to 'omit' to copy without the due date." });
        return;
      }
      const sourceMaterials = deduplicateMaterials(item.materials || []);
      const attachments = sourceMaterials.map((m) => {
        if (m.driveFile?.driveFile?.id) {
          const newId = state.files[m.driveFile.driveFile.id];
          return newId ? { driveFile: { driveFile: { id: newId }, shareMode: m.driveFile.shareMode } } : null;
        }
        if (m.youtubeVideo) return { youtubeVideo: m.youtubeVideo };
        if (m.link) return { link: m.link };
        return null;
      });
      const missing = sourceMaterials.length - attachments.filter(Boolean).length;
      if (missing) { noteFailure(`${kind}:${item.id}`, { kind, title: item.title || item.text, sourceId: item.id, error: `${missing} unsupported or failed attachment(s); post left unpublished.` }); return; }
      const mappedTopic = item.topicId ? state.topics[`topic:${item.topicId}`] : undefined;
      if (item.topicId && !mappedTopic) {
        noteFailure(`${kind}:${item.id}`, { kind, title: item.title || item.text, sourceId: item.id, error: "Topic could not be mapped; post left unpublished." });
        return;
      }
      let payload = { state: "PUBLISHED", materials: attachments };
      if (kind === "coursework") {
        payload = { ...payload, title: item.title, description: item.description, workType: item.workType, maxPoints: item.maxPoints, dueDate: item.dueDate, dueTime: item.dueTime, scheduledTime: item.scheduledTime, topicId: mappedTopic, submissionModificationMode: item.submissionModificationMode, multipleChoiceQuestion: item.multipleChoiceQuestion, assigneeMode: "ALL_STUDENTS" };
        if (expiredDueDate) { delete payload.dueDate; delete payload.dueTime; }
        for (const field of ["title", "description", "workType", "maxPoints", "dueDate", "dueTime", "scheduledTime", "topicId", "submissionModificationMode", "multipleChoiceQuestion"]) if (payload[field] === undefined) delete payload[field];
      } else if (kind === "material") {
        payload = { ...payload, title: item.title, description: item.description, topicId: mappedTopic };
        if (payload.topicId === undefined) delete payload.topicId;
      } else payload.text = item.text;
      const suffix = kind === "coursework" ? "courseWork" : kind === "material" ? "courseWorkMaterials" : "announcements";
      try {
        const created = await classroom("POST", `/courses/${destinationCourseId}/${suffix}`, payload);
        if (expiredDueDate) (state.omittedDueDates ||= {})[key] = item.dueDate;
        state.posts[key] = created.id; delete state.failures[key]; checkpoint();
      } catch (e) { noteFailure(key, { kind, title: item.title || item.text, sourceId: item.id, error: e.message }); }
      if (item.rubrics?.length && kind === "coursework" && state.posts[key]) {
        state.rubrics[key] ||= 0;
        for (let rubricIndex = state.rubrics[key]; rubricIndex < item.rubrics.length; rubricIndex++) {
          try {
            const rubric = item.rubrics[rubricIndex];
            await classroom("POST", `/courses/${destinationCourseId}/courseWork/${state.posts[key]}/rubrics`, { criteria: rubric.criteria, points: rubric.points, levels: rubric.levels });
            state.rubrics[key] = rubricIndex + 1; delete state.failures[`rubric:${key}:${rubricIndex}`]; checkpoint();
          } catch (e) {
            noteFailure(`rubric:${key}:${rubricIndex}`, { kind: "rubric", title: item.title, sourceId: item.id, unsupported: true, error: e.message });
            break;
          }
        }
      }
    };
    for (const item of coursework) await createPost("coursework", item);
    for (const item of materials) await createPost("material", item);
    for (const item of announcements) await createPost("announcement", item);
    const copiedByKind = { coursework: 0, materials: 0, announcements: 0 };
    for (const key of Object.keys(state.posts)) {
      const kind = key.split(":", 1)[0];
      if (kind === "coursework") copiedByKind.coursework++;
      if (kind === "material") copiedByKind.materials++;
      if (kind === "announcement") copiedByKind.announcements++;
    }
    return { dryRun: false, counts: { topics: Object.keys(state.topics).length, ...copiedByKind, uniqueDriveFiles: Object.keys(state.files).length }, omittedDueDates: Object.entries(state.omittedDueDates || {}).map(([sourcePost, dueDate]) => ({ sourcePost, dueDate })), failures: Object.values(state.failures), resumeLedger: ledgerPath };
  };
}

function targetFolderName(items, driveId, topics = []) {
  const owner = items.find((x) => (x.materials || []).some((m) => m.driveFile?.driveFile?.id === driveId));
  const topic = topics.find((x) => x.topicId === owner?.topicId);
  const text = `${owner?.title || ""} ${owner?.description || ""} ${owner?.text || ""} ${topic?.name || ""}`;
  const match = text.match(/\b(?:week|wk)\s*0*(\d+)\b|\bW\s*0*(\d+)\b/i);
  return match ? `[WK${Number(match[1] || match[2])}]` : "root";
}

function deduplicateMaterials(materials) {
  const seen = new Set();
  return materials.filter((material) => {
    const content = material.driveFile?.driveFile?.id ? `drive:${material.driveFile.driveFile.id}`
      : material.youtubeVideo?.id ? `youtube:${material.youtubeVideo.id}`
        : material.link?.url ? `link:${material.link.url}` : JSON.stringify(material);
    if (seen.has(content)) return false;
    seen.add(content);
    return true;
  });
}

function isPastDue(dueDate) {
  if (!dueDate?.year || !dueDate?.month || !dueDate?.day) return false;
  const dueDay = Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return dueDay < today;
}
