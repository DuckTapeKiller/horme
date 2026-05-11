import { App, Modal, Setting } from "obsidian";
import HormePlugin from "../../main";

export interface TaxonomyMergeSuggestion {
    from: string;
    to: string;
    reason: string;
}

export class TaxonomyAuditModal extends Modal {
    plugin: HormePlugin;
    suggestions: TaxonomyMergeSuggestion[];
    selectedPairs: { from: string; to: string }[] = [];

    constructor(app: App, plugin: HormePlugin, suggestions: TaxonomyMergeSuggestion[]) {
        super(app);
        this.plugin = plugin;
        this.suggestions = suggestions;
        
        // Default to all selected
        this.selectedPairs = suggestions.map(s => ({ from: s.from, to: s.to }));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("horme-taxonomy-audit-modal");

        contentEl.createEl("h2", { text: "Taxonomy Audit Suggestions" });
        contentEl.createEl("p", { 
            text: "The AI has analyzed your vault's tags and found the following inconsistencies. Review the suggestions below and uncheck any you wish to ignore.",
            cls: "setting-item-description"
        });

        if (this.suggestions.length === 0) {
            contentEl.createEl("p", { text: "No taxonomy issues found! Your tags are perfectly organized." });
            return;
        }

        const tableContainer = contentEl.createEl("div", { cls: "horme-taxonomy-table-container", attr: { style: "max-height: 400px; overflow-y: auto; margin: 20px 0; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s);" } });
        
        const table = tableContainer.createEl("table", { cls: "horme-taxonomy-table", attr: { style: "width: 100%; border-collapse: collapse; text-align: left;" } });
        const thead = table.createEl("thead");
        const headerRow = thead.createEl("tr", { attr: { style: "background-color: var(--background-secondary);" } });
        
        headerRow.createEl("th", { text: "Apply", attr: { style: "padding: 10px; border-bottom: 1px solid var(--background-modifier-border);" } });
        headerRow.createEl("th", { text: "Current Tag", attr: { style: "padding: 10px; border-bottom: 1px solid var(--background-modifier-border);" } });
        headerRow.createEl("th", { text: "Suggested Merge", attr: { style: "padding: 10px; border-bottom: 1px solid var(--background-modifier-border);" } });
        headerRow.createEl("th", { text: "AI Reasoning", attr: { style: "padding: 10px; border-bottom: 1px solid var(--background-modifier-border);" } });

        const tbody = table.createEl("tbody");

        this.suggestions.forEach((suggestion, index) => {
            const tr = tbody.createEl("tr", { attr: { style: "border-bottom: 1px solid var(--background-modifier-border-hover);" } });
            
            const tdCheckbox = tr.createEl("td", { attr: { style: "padding: 10px; text-align: center;" } });
            const checkbox = tdCheckbox.createEl("input", { type: "checkbox" });
            checkbox.checked = true;
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this.selectedPairs.push({ from: suggestion.from, to: suggestion.to });
                } else {
                    this.selectedPairs = this.selectedPairs.filter(p => p.from !== suggestion.from);
                }
            };

            tr.createEl("td", { text: suggestion.from, attr: { style: "padding: 10px; color: var(--text-error);" } });
            tr.createEl("td", { text: suggestion.to, attr: { style: "padding: 10px; color: var(--text-success);" } });
            tr.createEl("td", { text: suggestion.reason, attr: { style: "padding: 10px; font-size: 0.9em; color: var(--text-muted);" } });
        });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("Cancel")
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText("Apply Selected")
                .setCta()
                .onClick(async () => {
                    this.close();
                    if (this.selectedPairs.length > 0) {
                        await this.plugin.taxonomyAuditor.executeTagRenameBatch(this.selectedPairs);
                    }
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
