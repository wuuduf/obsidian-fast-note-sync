import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = path.resolve(import.meta.dirname, "../src/lib/blog/blog_publisher.ts");
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const textInputs = [];
const buttons = new Map();
class Modal {
  contentEl = { empty() {}, createEl() {} };
  open() { this.onOpen(); }
  close() {}
}
class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addToggle(callback) { callback(this); return this; }
  addDropdown(callback) { callback(this); return this; }
  addText(callback) {
    callback({ setValue(value) { textInputs.push(value); return this; }, onChange() {} });
    return this;
  }
  addButton(callback) { callback(this); return this; }
  setValue() { return this; }
  onChange() { return this; }
  addOption() { return this; }
  setButtonText(value) { this.buttonText = value; return this; }
  setCta() { return this; }
  onClick(callback) { buttons.set(this.buttonText, callback); return this; }
}
const module = { exports: {} };
vm.runInNewContext(transpiled, {
  module,
  exports: module.exports,
  require(id) {
    if (id === "obsidian") return { Modal, Setting, Notice: class {}, TFile: class {} };
    if (id === "../../i18n/lang") return { $: (key) => key };
    throw new Error(`Unexpected require: ${id}`);
  },
}, { filename: sourcePath });

const { BlogPublisher } = module.exports;
const file = { path: "Blog/note.md", basename: "note", extension: "md" };
function publisherFor(frontmatter) {
  return new BlogPublisher({ app: {
    workspace: { getActiveFile: () => file },
    fileManager: { processFrontMatter: async (_, update) => update(frontmatter) },
    metadataCache: { getFileCache: () => ({ frontmatter }) },
  } });
}

for (const type of ["post", "dynamic"]) {
  const frontmatter = {
    title: "Note", published: "2026-08-01 14:05:06",
    slug: "edited-in-properties", blog: { enabled: true, type, slug: "stale-nested-slug" },
  };
  await publisherFor(frontmatter).markCurrentNote(type);
  assert.equal(frontmatter.slug, "edited-in-properties");
  assert.equal(frontmatter.blog.slug, "edited-in-properties");

  const editorFrontmatter = { slug: "edited-in-properties", blog: { type, slug: "stale-nested-slug" } };
  await publisherFor(editorFrontmatter).editCurrentNoteProperties();
  assert.equal(textInputs.at(-1), "edited-in-properties", "the editor must display the slug used by the server");
}

const legacy = { published: "2026-08-01", blog: { type: "post", slug: "nested-only" } };
await publisherFor(legacy).markCurrentNote("post");
assert.equal(legacy.slug, "nested-only", "existing notes without a flat slug remain supported");

const converted = { published: "2026-08-01 14:05:06", slug: "post-slug", blog: { type: "post", slug: "post-slug" } };
await publisherFor(converted).markCurrentNote("dynamic");
assert.equal(converted.slug, "2026-08-01-140506", "switching to dynamic still derives its timestamp slug");

for (const type of ["post", "dynamic"]) {
  const fresh = { title: "  ", blog: { type } };
  await publisherFor(fresh).editCurrentNoteProperties();
  buttons.get("保存")();
  await Promise.resolve();
  assert.match(fresh.published, /^\d{4}-\d{2}-\d{2}/, "saving enabled publication properties must initialize a publish date");
  if (type === "post") assert.equal(fresh.title, "note", "a blank title must use the note name");
}

const disabled = { blog: { enabled: false } };
await publisherFor(disabled).editCurrentNoteProperties();
buttons.get("保存")();
await Promise.resolve();
assert.equal(disabled.published, undefined, "disabling publication must not invent a publication date");

const existingDate = { published: "2025-05-01", title: "Custom title" };
await publisherFor(existingDate).editCurrentNoteProperties();
buttons.get("保存")();
await Promise.resolve();
assert.equal(existingDate.published, "2025-05-01");
assert.equal(existingDate.title, "Custom title");

// Commands and the retry entry share the same in-flight request for a note;
// failed network requests must release that guard for the next explicit retry.
for (const fail of [false, true]) {
  let complete;
  let reject;
  let calls = 0;
  const pending = new Promise((resolve, failRequest) => { complete = resolve; reject = failRequest; });
  const publisher = new BlogPublisher({
    settings: { api: "https://sync.example.test", apiToken: "fixture-token", vault: "Test" },
    app: { workspace: { getActiveFile: () => file } },
    api: { executeBlogPublish: async () => { calls++; if (calls === 1) await pending; } },
  });
  const initial = publisher.publishCurrentNote();
  const duplicate = publisher.retryCurrentNote();
  assert.equal(calls, 1, "a pending publish must not enqueue a duplicate job");
  if (fail) reject(new Error("temporary network failure")); else complete();
  await Promise.all([initial, duplicate]);
  await publisher.retryCurrentNote();
  assert.equal(calls, 2, "settlement must release the guard for another explicit request");
}
