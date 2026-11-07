import { ButtonComponent, requireApiVersion } from "obsidian";

/**
 * Styles a button whose action deletes data. Obsidian 1.13 has its own style for
 * it; before 1.13 the button gets the warning style through its class.
 */
export function markDestructive(button: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) {
    button.setDestructive();
  } else {
    button.buttonEl.addClass("mod-warning");
  }
  return button;
}
