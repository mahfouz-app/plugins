// Everything the plugin's frontend module uses from Excalidraw and React,
// as one ES module with no bare imports, so the app's webview can import it
// from the plugin's own URL. React comes with it: the app's own React (if
// any) isn't reachable from a plugin.
import "@excalidraw/excalidraw/index.css";

export {
  Excalidraw,
  exportToSvg,
  restore,
  serializeAsJSON,
  getNonDeletedElements,
} from "@excalidraw/excalidraw";
export { createElement } from "react";
export { createRoot } from "react-dom/client";
