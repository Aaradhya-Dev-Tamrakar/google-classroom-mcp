import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCourseCopier } from "../course-copy.mjs";

const sourceId = "src";
const destinationId = "dst";
const folderId = "parent";

function setup(t, { failFile = false, permissionDenied = false, studentCount = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-copy-test-"));
  const tokenPath = path.join(dir, "drive-token.json");
  const oauthPath = path.join(dir, "drive-oauth.json");
  const ledgerPath = path.join(dir, "ledger.json");
  fs.writeFileSync(tokenPath, JSON.stringify({ access_token: "test", expiry_date: Date.now() + 3600000 }));
  fs.writeFileSync(oauthPath, JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }));
  process.env.DRIVE_CREDENTIALS_PATH = tokenPath;
  process.env.DRIVE_OAUTH_PATH = oauthPath;
  const counts = { fileCopies: 0, postCreates: 0, topicCreates: 0 };
  const sourcePost = {
    id: "cw1", title: "Week 1: Lab", description: "Do it", state: "PUBLISHED", workType: "ASSIGNMENT",
    maxPoints: 10, dueDate: { year: 2026, month: 10, day: 20 }, topicId: "topic1",
    materials: [{ driveFile: { driveFile: { id: "file1" }, shareMode: "STUDENT_COPY" } }],
  };
  const classroomFetch = async (url, options = {}) => {
    const route = new URL(url).pathname.replace("/v1", "");
    let body = {};
    if (options.body) body = JSON.parse(options.body);
    if (options.method === "POST") {
      if (route.endsWith("/topics")) { counts.topicCreates++; return Response.json({ topicId: "dest-topic" }); }
      if (route.endsWith("/courseWork")) { counts.postCreates++; return Response.json({ id: "dest-cw" }); }
    }
    if (route === `/courses/${sourceId}`) return Response.json({ id: sourceId, name: "Source", courseState: "ACTIVE" });
    if (route === `/courses/${destinationId}`) return Response.json({ id: destinationId, name: "Destination", courseState: "ACTIVE" });
    if (route.endsWith("/students")) return Response.json({ students: Array.from({ length: studentCount }, (_, i) => ({ userId: `student-${i}` })) });
    if (route.endsWith("/topics")) return Response.json({ topic: [{ topicId: "topic1", name: "Week 1" }] });
    if (route.endsWith("/courseWork")) return Response.json({ courseWork: [sourcePost] });
    if (route.endsWith("/courseWorkMaterials")) return Response.json({ courseWorkMaterial: [] });
    if (route.endsWith("/announcements")) return Response.json({ announcements: [] });
    return Response.json({ error: `Unhandled ${options.method || "GET"} ${route}` }, { status: 404 });
  };
  const driveFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace("/drive/v3", "");
    if (route === "/files" && options.method !== "POST") return Response.json({ files: [] });
    if (route === "/files/file1") {
      if (permissionDenied) return Response.json({ error: { message: "insufficient permissions" } }, { status: 403 });
      if (failFile) return Response.json({ error: { message: "not found" } }, { status: 404 });
      return Response.json({ id: "file1", name: "lab.pdf" });
    }
    if (route === "/files/file1/copy") { counts.fileCopies++; return Response.json({ id: "copied-file" }); }
    if (route === "/files" && options.method === "POST") return Response.json({ id: "week-folder" });
    return Response.json({ files: [] });
  };
  t.after(() => {
    delete process.env.DRIVE_CREDENTIALS_PATH;
    delete process.env.DRIVE_OAUTH_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { copy: createCourseCopier({ classroomFetch, driveFetch, ledgerPath }), counts };
}

test("dry run previews published counts and attachment destination without writes", async (t) => {
  const { copy, counts } = setup(t);
  const result = await copy({ sourceCourseId: sourceId, destinationCourseId: destinationId, driveFolderId: folderId });
  assert.equal(result.dryRun, true);
  assert.equal(result.counts.coursework, 1);
  assert.equal(result.files[0].folder, "[WK1]");
  assert.equal(counts.postCreates, 0);
  assert.equal(counts.fileCopies, 0);
});

test("retry uses the local ledger and does not duplicate copied files or posts", async (t) => {
  const { copy, counts } = setup(t);
  const args = { sourceCourseId: sourceId, destinationCourseId: destinationId, driveFolderId: folderId, dryRun: false };
  await copy(args);
  await copy(args);
  assert.equal(counts.fileCopies, 1);
  assert.equal(counts.postCreates, 1);
  assert.equal(counts.topicCreates, 1);
});

test("missing source attachment is reported and its post is not created", async (t) => {
  const { copy, counts } = setup(t, { failFile: true });
  const result = await copy({ sourceCourseId: sourceId, destinationCourseId: destinationId, driveFolderId: folderId, dryRun: false });
  assert.ok(result.failures.some((failure) => failure.kind === "driveFile"));
  assert.ok(result.failures.some((failure) => failure.kind === "coursework" && /left unpublished/.test(failure.error)));
  assert.equal(counts.postCreates, 0);
});

test("Drive permission failure is reported as partial copy and keeps the post unpublished", async (t) => {
  const { copy, counts } = setup(t, { permissionDenied: true });
  const result = await copy({ sourceCourseId: sourceId, destinationCourseId: destinationId, driveFolderId: folderId, dryRun: false });
  assert.ok(result.failures.some((failure) => failure.kind === "driveFile" && /403/.test(failure.error)));
  assert.ok(result.failures.some((failure) => failure.kind === "coursework" && /left unpublished/.test(failure.error)));
  assert.equal(counts.postCreates, 0);
});

test("apply stops before writes when destination has enrolled students", async (t) => {
  const { copy, counts } = setup(t, { studentCount: 2 });
  await assert.rejects(copy({ sourceCourseId: sourceId, destinationCourseId: destinationId, driveFolderId: folderId, dryRun: false }), /has 2 student/);
  assert.equal(counts.fileCopies, 0);
  assert.equal(counts.postCreates, 0);
});
