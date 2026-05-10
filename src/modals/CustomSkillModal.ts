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

  constructor(app: App, plugin: HormePlugin, onSave: (def: CustomSkillDefinition) => void) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Create HTTP Skill" });

    contentEl.createEl("p", {
      cls: "horme-settings-muted",
      text: "Use {{query}} as a placeholder for the user's input in the URL and body."
    });

    new Setting(contentEl)
      .setName("Skill Name")
      .setDesc("Shown in the Skills dropdown.")
      .addText(t => t
        .setPlaceholder("RAE Dictionary")
        .onChange(v => { this.name = v.trim(); })
      );

    new Setting(contentEl)
      .setName("Description")
      .setDesc("One line shown under the name.")
      .addText(t => t
        .setPlaceholder("Look up Spanish words in the RAE dictionary.")
        .onChange(v => { this.description = v.trim(); })
      );

    new Setting(contentEl)
      .setName("Method")
      .addDropdown(d => d
        .addOption("GET", "GET")
        .addOption("POST", "POST")
        .setValue(this.method)
        .onChange(v => {
          this.method = v as "GET" | "POST";
          bodySetting.settingEl.style.display = v === "POST" ? "" : "none";
        })
      );

    const urlSetting = new Setting(contentEl)
      .setName("URL")
      .setDesc("Use {{query}} where the user's input should go.")
      .addText(t => {
        t.setPlaceholder("https://api.example.com/search?q={{query}}");
        t.inputEl.style.width = "100%";
        t.onChange(v => { this.url = v.trim(); });
      });
    urlSetting.settingEl.addClass("horme-modal-vertical-setting");

    const headersSetting = new Setting(contentEl)
      .setName("Headers")
      .setDesc("One per line: Key: Value. Leave empty if not needed.")
      .addTextArea(t => {
        t.setPlaceholder("Authorization: Bearer sk-...\nX-Custom: value");
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        t.inputEl.style.resize = "vertical";
        t.onChange(v => { this.headersRaw = v; });
      });
    headersSetting.settingEl.addClass("horme-modal-vertical-setting");

    const bodySetting = new Setting(contentEl)
      .setName("Request Body (POST only)")
      .setDesc("JSON body template. Use {{query}} for the user's input.")
      .addTextArea(t => {
        t.setPlaceholder('{"q": "{{query}}", "source": "en", "target": "fr"}');
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
        t.inputEl.style.resize = "vertical";
        t.onChange(v => { this.body = v; });
      });
    bodySetting.settingEl.addClass("horme-modal-vertical-setting");
    bodySetting.settingEl.style.display = this.method === "POST" ? "" : "none";

    new Setting(contentEl)
      .setName("Response Path")
      .setDesc("Dot-path to extract data from JSON response (e.g. results[0].text). Leave empty to use full response.")
      .addText(t => {
        t.setPlaceholder("data.items[0].content");
        t.inputEl.style.width = "100%";
        t.onChange(v => { this.responsePath = v.trim(); });
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText("Save Skill")
        .setCta()
        .onClick(() => {
          if (!this.name) { new Notice("Skill name is required."); return; }
          if (!this.description) { new Notice("Description is required."); return; }
          if (!this.url) { new Notice("URL is required."); return; }
          if (!this.url.includes("{{query}}") && this.method === "GET") {
            new Notice("URL must include {{query}} placeholder for GET requests.");
            return;
          }

          const id = "custom_" + this.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

          // Prevent duplicate IDs
          const exists = this.plugin.settings.customSkills.some(s => s.id === id);
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
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
