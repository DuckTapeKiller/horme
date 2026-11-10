import { App, Modal, Setting, Notice } from "obsidian";
import HormePlugin from "../../main";
import { CustomSkillDefinition } from "../types";

export class CustomSkillModal extends Modal {
  private plugin: HormePlugin;
  private onSave: (def: CustomSkillDefinition) => void;
  private name = "";
  private description = "";
  private url = "";
  private method: "GET" | "POST" = "GET";
  private headersRaw = "";
  private body = "";
  private responsePath = "";
  /** Set when an existing skill is being edited; it keeps its id. */
  private existingId: string | null = null;

  constructor(
    app: App,
    plugin: HormePlugin,
    onSave: (def: CustomSkillDefinition) => void,
    existing?: CustomSkillDefinition,
  ) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
    if (existing) {
      this.existingId = existing.id;
      this.name = existing.name;
      this.description = existing.description;
      this.url = existing.url;
      this.method = existing.method;
      this.headersRaw = Object.entries(existing.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      this.body = existing.body ?? "";
      this.responsePath = existing.responsePath ?? "";
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.existingId ? "Edit HTTP skill" : "Create HTTP skill" });

    contentEl.createEl("p", {
      cls: "horme-settings-muted",
      text: "Use {{query}} as a placeholder for the user's input in the URL and body. For sensitive values (API keys/tokens), use {{secret:your-secret-id}} in headers/body to pull from Obsidian Secret Storage.",
    });

    new Setting(contentEl)
      .setName("Skill name")
      .setDesc("Shown in the skills dropdown.")
      .addText((t) =>
        t
          .setPlaceholder("RAE dictionary")
          .setValue(this.name)
          .onChange((v) => {
            this.name = v.trim();
          }),
      );

    new Setting(contentEl)
      .setName("Description")
      .setDesc("One line shown under the name.")
      .addText((t) =>
        t
          .setPlaceholder("Look up Spanish words in the RAE dictionary.")
          .setValue(this.description)
          .onChange((v) => {
            this.description = v.trim();
          }),
      );

    new Setting(contentEl).setName("Method").addDropdown((d) =>
      d
        .addOption("GET", "GET")
        .addOption("POST", "POST")
        .setValue(this.method)
        .onChange((v) => {
          this.method = v as "GET" | "POST";
          bodySetting.settingEl.setCssProps({ display: v === "POST" ? "" : "none" });
        }),
    );

    const urlSetting = new Setting(contentEl)
      .setName("URL")
      .setDesc("Use {{query}} where the user's input should go.")
      .addText((t) => {
        t.setPlaceholder("https://api.example.com/search?q={{query}}").setValue(this.url);
        t.inputEl.addClass("horme-full-width");
        t.onChange((v) => {
          this.url = v.trim();
        });
      });
    urlSetting.settingEl.addClass("horme-modal-vertical-setting");

    const headersSetting = new Setting(contentEl)
      .setName("Headers")
      .setDesc(
        "One per line: Key: Value. Use {{secret:your-secret-id}} to avoid storing tokens in data.json.",
      )
      .addTextArea((t) => {
        t.setPlaceholder("Authorization: Bearer {{secret:horme-openai-api-key}}\nX-Custom: value").setValue(
          this.headersRaw,
        );
        t.inputEl.rows = 3;
        t.inputEl.addClasses(["horme-full-width", "horme-resize-vertical"]);
        t.onChange((v) => {
          this.headersRaw = v;
        });
      });
    headersSetting.settingEl.addClass("horme-modal-vertical-setting");

    const bodySetting = new Setting(contentEl)
      .setName("Request body (POST only)")
      .setDesc("JSON body template. Use {{query}} for the user's input.")
      .addTextArea((t) => {
        t.setPlaceholder('{"q": "{{query}}", "source": "en", "target": "fr"}').setValue(this.body);
        t.inputEl.rows = 4;
        t.inputEl.addClasses(["horme-full-width", "horme-resize-vertical"]);
        t.onChange((v) => {
          this.body = v;
        });
      });
    bodySetting.settingEl.addClass("horme-modal-vertical-setting");
    bodySetting.settingEl.setCssProps({ display: this.method === "POST" ? "" : "none" });

    new Setting(contentEl)
      .setName("Response path")
      .setDesc(
        "Dot-path to extract data from JSON response (e.g. results[0].text). Leave empty to use full response.",
      )
      .addText((t) => {
        t.setPlaceholder("data.items[0].content").setValue(this.responsePath);
        t.inputEl.addClass("horme-full-width");
        t.onChange((v) => {
          this.responsePath = v.trim();
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save skill")
        .setCta()
        .onClick(() => {
          if (!this.name) {
            new Notice("Skill name is required.");
            return;
          }
          if (!this.description) {
            new Notice("Description is required.");
            return;
          }
          if (!this.url) {
            new Notice("URL is required.");
            return;
          }
          if (!this.url.includes("{{query}}") && this.method === "GET") {
            new Notice("URL must include {{query}} placeholder for GET requests.");
            return;
          }

          // Names with no Latin letters (e.g. Japanese) would all slug to "custom__",
          // so they get a time-based id instead.
          const slug = this.name
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
          const id = this.existingId ?? "custom_" + (slug || Date.now().toString(36));

          // Prevent duplicate IDs and names (an edited skill may keep its own).
          const exists = this.plugin.settings.customSkills.some(
            (s) =>
              s.id !== this.existingId &&
              (s.id === id || s.name.trim().toLowerCase() === this.name.trim().toLowerCase()),
          );
          if (exists) {
            new Notice(`A custom skill named "${this.name}" already exists.`);
            return;
          }

          // Parse headers from raw text
          const headers: Record<string, string> = {};
          for (const line of this.headersRaw.split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) {
              headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
          }

          this.onSave({
            id,
            name: this.name,
            description: this.description,
            url: this.url,
            method: this.method,
            headers,
            body: this.body.trim(),
            responsePath: this.responsePath,
          });
          this.close();
        }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
