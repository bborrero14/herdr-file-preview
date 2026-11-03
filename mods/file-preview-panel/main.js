// Launcher: toggles file-preview as a right panel of the current tab, sized to 45 %.
// A keys.json binding can't pass pane.split its mod and props, so this lives for one init.
import { View, div } from "gpui-kit";
import { props, closeOverlay } from "herdr";
import { toggle } from "./dock.js";

export default class Launcher extends View {
  init() {
    const overlay = props()?.overlay;      // props(), not init's argument (it arrives undefined)
    try { toggle(); }
    finally { if (overlay) closeOverlay(overlay); }   // `herdr-app check` has no overlay; closeOverlay(null) throws
  }
  render() { return div(); }
}
