import { Modal, Notice, Setting, TFile } from "obsidian";

import type FastSync from "../../main";
import { $ } from "../../i18n/lang";

type BlogFrontmatter = {
  enabled?: boolean;
  type?: "post" | "dynamic";
  slug?: string;
};

type PostDefaultValue = string | boolean | readonly string[];

const POST_DEFAULTS: Readonly<Record<string, PostDefaultValue>> = {
  draft: false,
  description: "",
  image: "",
  tags: [],
  category: "",
  lang: "",
  pinned: false,
  author: "",
  sourceLink: "",
  licenseName: "",
  licenseUrl: "",
  comment: true,
  password: "",
  passwordHint: "",
};

function localPublishedDate(type: "post" | "dynamic", value = new Date()): string {
  const date = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
  if (type === "post") return date;
  const time = [value.getHours(), value.getMinutes(), value.getSeconds()]
    .map(part => String(part).padStart(2, "0"))
    .join(":");
  return `${date} ${time}`;
}

/**
 * Thin Obsidian-side adapter for the server-owned Firefly projection.
 * It only edits publication metadata and starts a server job; Git credentials,
 * transforms, commits and pushes deliberately remain on fast-note-sync-service.
 */
export class BlogPublisher {
  private readonly pendingPublishes = new Set<string>();
  constructor(private readonly plugin: FastSync) {}

  async markCurrentNote(type: "post" | "dynamic" = "post"): Promise<void> {
    const file = this.activeMarkdownFile();
    if (!file) return;

    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const data = frontmatter as unknown as Record<string, unknown>;
      const current = this.asBlogFrontmatter(data.blog);
      const isDynamic = type === "dynamic";

      if (!data.published) {
        data.published = localPublishedDate(type);
      }

      const slug = this.slugFor(data.published, file, current, type, data.slug);
      data.blog = {
        ...current,
        enabled: true,
        type,
        slug,
      } satisfies BlogFrontmatter;

      // Keep a flat slug as well. Obsidian's Properties view cannot edit
      // nested objects such as `blog.slug`; the server prefers this editable
      // flat value and uses the nested value only as a legacy fallback.
      data.slug = slug;

      if (!isDynamic) {
        if (typeof data.title !== "string" || !data.title.trim()) {
          data.title = file.basename;
        }
        if (!("updated" in data)) {
          data.updated = data.published;
        }
        if (!("slug" in data) || typeof data.slug !== "string" || !data.slug.trim()) {
          data.slug = slug;
        }
        for (const [key, value] of Object.entries(POST_DEFAULTS)) {
          if (!(key in data)) {
            // Arrays must not be shared between notes because Obsidian may
            // mutate the frontmatter value in place.
            data[key] = typeof value === "string" || typeof value === "boolean" ? value : [];
          }
        }
      }
    });

    new Notice($(type === "dynamic" ? "ui.blog.marked_dynamic" : "ui.blog.marked", { path: file.path }));
  }

  async publishCurrentNote(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (!file) return;
    await this.publish(file.path);
  }

  /** Re-submit the current note after a transient server or Git failure. */
  async retryCurrentNote(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (!file) return;
    await this.publish(file.path);
  }

  async publishAll(): Promise<void> {
    await this.publish();
  }

  async editCurrentNoteProperties(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (!file) return;
    new BlogPropertiesModal(this.plugin, file).open();
  }

  private async publish(path?: string): Promise<void> {
    if (!this.plugin.settings.api || !this.plugin.settings.apiToken || !this.plugin.settings.vault) {
      new Notice($("ui.blog.connection_required"));
      return;
    }

    const requestKey = JSON.stringify([this.plugin.settings.api, this.plugin.settings.vault, path ?? ""]);
    if (this.pendingPublishes.has(requestKey)) return;
    this.pendingPublishes.add(requestKey);

    try {
      const result = await this.plugin.api.executeBlogPublish(path);
      const message = path
        ? $("ui.blog.publish_started_note", { path })
        : $("ui.blog.publish_started_all");
      new Notice(result?.traceId ? `${message}\n诊断 ID: ${result.traceId}` : message, 8000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice($("ui.blog.publish_failed", { message }), 8000);
    } finally {
      this.pendingPublishes.delete(requestKey);
    }
  }

  private activeMarkdownFile(): TFile | null {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice($("ui.blog.markdown_only"));
      return null;
    }
    return file;
  }

  private asBlogFrontmatter(value: unknown): BlogFrontmatter {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      type: record.type === "post" || record.type === "dynamic" ? record.type : undefined,
      slug: typeof record.slug === "string" ? record.slug : undefined,
    };
  }

  private defaultSlug(file: TFile): string {
    const slug = file.basename
      .trim()
      .replace(/[\\/:*?"<>|#]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || `post-${Date.now()}`;
  }

  private slugFor(
    published: unknown,
    file: TFile,
    current: BlogFrontmatter,
    type: "post" | "dynamic",
    topLevelSlug: unknown,
  ): string {
    if ((current.type === type || type === "post") && typeof topLevelSlug === "string" && topLevelSlug.trim()) {
      return topLevelSlug.trim();
    }
    if (current.type === type && current.slug?.trim()) {
      return current.slug.trim();
    }
    if (type === "dynamic") {
      return this.dynamicSlug(published) || localPublishedDate("dynamic").replace(" ", "-").replace(/:/g, "");
    }
    return this.defaultSlug(file);
  }

  private dynamicSlug(value: unknown): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
    }
    if (typeof value !== "string") return "";
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
    if (!match) return "";
    return `${match[1]}-${match[2]}-${match[3]}-${match[4] || "00"}${match[5] || "00"}${match[6] || "00"}`;
  }
}

/** Small editor for the nested `blog` publication metadata. */
class BlogPropertiesModal extends Modal {
  private enabled = true;
  private type: "post" | "dynamic" = "post";
  private slug = "";

  constructor(private readonly plugin: FastSync, private readonly file: TFile) {
    super(plugin.app);
    const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    const blog = frontmatter?.blog as Record<string, unknown> | undefined;
    this.enabled = typeof blog?.enabled === "boolean" ? blog.enabled : true;
    this.type = blog?.type === "dynamic" ? "dynamic" : "post";
    this.slug = typeof frontmatter?.slug === "string" && frontmatter.slug.trim()
      ? frontmatter.slug.trim()
      : (typeof blog?.slug === "string" ? blog.slug : file.basename);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "博客发布属性" });
    contentEl.createEl("p", { text: this.file.path, cls: "setting-item-description" });

    new Setting(contentEl)
      .setName("启用发布")
      .setDesc("关闭后，下一次发布会安全删除该文章的受管文件")
      .addToggle(toggle => toggle.setValue(this.enabled).onChange(value => { this.enabled = value; }));
    new Setting(contentEl)
      .setName("内容类型")
      .addDropdown(dropdown => dropdown
        .addOption("post", "博客文章")
        .addOption("dynamic", "博客动态")
        .setValue(this.type)
        .onChange(value => { this.type = value === "dynamic" ? "dynamic" : "post"; }));
    new Setting(contentEl)
      .setName("Slug")
      .setDesc("将作为博客仓库中的文件名")
      .addText(text => text.setValue(this.slug).onChange(value => { this.slug = value.trim(); }));
    new Setting(contentEl)
      .addButton(button => button.setButtonText("保存").setCta().onClick(() => { void this.save(); }))
      .addButton(button => button.setButtonText("取消").onClick(() => this.close()));
  }

  private async save(): Promise<void> {
    if (!this.slug) {
      new Notice("Slug 不能为空");
      return;
    }
    await this.plugin.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
      const data = frontmatter as Record<string, unknown>;
      const existingValue = data.blog;
      const existing = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
        ? existingValue as Record<string, unknown>
        : {};
      data.blog = { ...existing, enabled: this.enabled, type: this.type, slug: this.slug };
      data.slug = this.slug;
      if (this.enabled && !data.published) {
        data.published = localPublishedDate(this.type);
      }
      if (this.enabled && this.type === "post" && (typeof data.title !== "string" || !data.title.trim())) {
        data.title = this.file.basename;
      }
    });
    new Notice("博客发布属性已保存");
    this.close();
  }
}
