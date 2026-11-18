import { normalizePath, MarkdownView, setIcon, Notice } from "obsidian";
import HormePlugin from "../../../main";
import { ensureVaultFolder } from "../../utils/vaultFolder";
import {
  FoundImage,
  cardCredit,
  imageFileName,
  isAllowedImageUrl,
  extensionForType,
} from "../../utils/images";
import { requestUrlWithTimeout } from "../../utils/requestWithTimeout";
import { WIKIMEDIA_HEADERS } from "../../utils/webResearch";
import { errorToMessage } from "../../utils/TypeGuards";
import { pingUnsplashDownload } from "../../services/ImageSearch";

/**
 * Picture cards in the chat: each found picture with its title, credit and
 * source, and a Save button that puts it in the vault (next to the current
 * note, or in the folder set under Images).
 */
export class ChatPictures {
  constructor(
    private plugin: HormePlugin,
    /** Called when a picture has loaded and the chat grew. */
    private onGrow: () => void,
  ) {}

  /** Image cards: the picture (opening its Wikimedia page), its title and credit, and Save to vault. */
  renderImageGallery(container: HTMLElement, images: FoundImage[]): void {
    const gallery = container.createDiv({
      cls: images.length > 1 ? "horme-image-gallery is-multiple" : "horme-image-gallery",
    });
    for (const img of images) {
      const card = gallery.createEl("figure", { cls: "horme-image-card" });
      const link = card.createEl("a", {
        cls: "horme-image-link",
        href: img.pageUrl || img.thumbUrl,
        attr: {
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `Open “${img.title}” at ${img.source}`,
        },
      });
      const picture = link.createEl("img", {
        cls: "horme-image",
        attr: { src: img.thumbUrl, alt: img.description || img.title, loading: "lazy", decoding: "async" },
      });
      // The real proportions keep the space reserved while the picture loads.
      if (img.width > 0 && img.height > 0) {
        picture.setAttr("width", String(img.width));
        picture.setAttr("height", String(img.height));
      }
      picture.addEventListener("load", () => this.onGrow());
      picture.addEventListener("error", () => {
        link.empty();
        link.addClass("is-broken");
        link.createSpan({ text: `The picture could not be loaded. Open its page at ${img.source}.` });
      });

      const caption = card.createEl("figcaption", { cls: "horme-image-caption" });
      const text = caption.createDiv({ cls: "horme-image-text" });
      text.createDiv({ cls: "horme-image-title", text: img.title });
      // Credit and where it is from ("Diliff · CC BY-SA 4.0 · Wikimedia Commons"), once.
      const credit = cardCredit(img);
      if (credit) text.createDiv({ cls: "horme-image-credit", text: credit });
      const save = caption.createEl("button", {
        cls: "horme-save-btn horme-image-save",
        attr: { "aria-label": "Save to vault" },
      });
      setIcon(save, "download");
      save.addEventListener("click", () => {
        void this.saveImageToVault(img, save);
      });
    }
  }

  /** "Name.jpg" in a folder, or "Name 1.jpg", "Name 2.jpg"… when that is taken. */
  async freePath(folder: string, fileName: string): Promise<string> {
    const dot = fileName.lastIndexOf(".");
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : "";
    const inFolder = (n: string) => normalizePath(folder === "/" ? n : `${folder}/${n}`);
    let candidate = inFolder(fileName);
    for (let i = 1; await this.plugin.app.vault.adapter.exists(candidate); i++)
      candidate = inFolder(`${base} ${i}${ext}`);
    return candidate;
  }

  /** Downloads the picture (a large copy, never a huge original) into the chosen folder. */
  async saveImageToVault(img: FoundImage, button: HTMLElement): Promise<void> {
    if (button.hasClass("is-busy")) return;
    button.addClass("is-busy");
    try {
      const urls = [img.saveUrl, img.thumbUrl].filter(
        (u, i, all) => isAllowedImageUrl(u) && all.indexOf(u) === i,
      );
      // Unsplash's guidelines ask for this call whenever one of its pictures is downloaded.
      if (img.downloadPing) await pingUnsplashDownload(this.plugin, img.downloadPing);
      let data: ArrayBuffer | null = null;
      let ext: string | undefined;
      for (const url of urls) {
        const res = await requestUrlWithTimeout({ url, headers: WIKIMEDIA_HEADERS, throw: false }, 30000);
        const type = (res.headers["content-type"] ?? res.headers["Content-Type"] ?? "").toLowerCase();
        // Only a picture is written to the vault, never an error page.
        if (res.status === 200 && res.arrayBuffer.byteLength > 0 && (!type || type.startsWith("image/"))) {
          data = res.arrayBuffer;
          ext = extensionForType(type);
          break;
        }
      }
      if (!data) throw new Error(`${img.source} did not send the picture.`);
      const view = this.plugin.lastActiveMarkdownLeaf?.view;
      const sourcePath =
        (view instanceof MarkdownView ? view.file?.path : undefined) ??
        this.plugin.app.workspace.getActiveFile()?.path ??
        "";
      const name = imageFileName(img, ext);
      const folder = this.plugin.settings.imageSaveFolder.trim();
      const path = folder
        ? await this.freePath(await ensureVaultFolder(this.plugin.app, folder), name)
        : await this.plugin.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const file = await this.plugin.app.vault.createBinary(path, data);
      setIcon(button, "check");
      button.setAttr("aria-label", `Saved to ${file.path}`);
      new Notice(`Horme: Picture saved to ${file.path}.`);
    } catch (e: unknown) {
      new Notice(`Horme: Could not save the picture. ${errorToMessage(e)}`);
    } finally {
      button.removeClass("is-busy");
    }
  }
}
