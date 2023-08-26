import { editor } from "$sb/silverbullet-syscall/mod.ts";
import { readSettings } from "$sb/lib/settings_page.ts";
import { updateMarkdownPreview } from "./preview.ts";
import { clientStore } from "$sb/silverbullet-syscall/mod.ts";

export async function togglePreview() {
  const currentValue = !!(await clientStore.get("enableMarkdownPreview"));
  await clientStore.set("enableMarkdownPreview", !currentValue);
  if (!currentValue) {
    await updateMarkdownPreview();
  } else {
    await hideMarkdownPreview();
  }
}

async function hideMarkdownPreview() {
  const setting = await readSettings({ previewOnRHS: true });
  await editor.hidePanel(setting.previewOnRHS ? "rhs" : "lhs");
}
