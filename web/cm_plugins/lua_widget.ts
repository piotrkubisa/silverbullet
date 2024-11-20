import { WidgetType } from "@codemirror/view";
import type { Client } from "../client.ts";
import type { ObjectValue } from "../../plug-api/types.ts";
import { renderMarkdownToHtml } from "../../plugs/markdown/markdown_render.ts";
import {
  isLocalPath,
  resolvePath,
} from "@silverbulletmd/silverbullet/lib/resolve";
import { parse } from "$common/markdown_parser/parse_tree.ts";
import { extendedMarkdownLanguage } from "$common/markdown_parser/parser.ts";
import { renderToText } from "@silverbulletmd/silverbullet/lib/tree";
import { activeWidgets } from "./markdown_widget.ts";
import { attachWidgetEventHandlers } from "./widget_util.ts";

export type LuaWidgetCallback = (
  bodyText: string,
  pageName: string,
) => Promise<LuaWidgetContent | null>;

export type LuaWidgetContent = {
  // Render as HTML
  html?: string;
  // Render as markdown
  markdown?: string;
  // CSS classes for wrapper
  cssClasses?: string[];
  // Index objects
  objects?: ObjectValue<any>[];
  display?: "block" | "inline";
} | string;

export class LuaWidget extends WidgetType {
  public dom?: HTMLElement;

  constructor(
    readonly from: number | undefined,
    readonly client: Client,
    readonly cacheKey: string,
    readonly bodyText: string,
    readonly callback: LuaWidgetCallback,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "sb-lua-directive";
    const cacheItem = this.client.getWidgetCache(this.cacheKey);
    if (cacheItem) {
      div.innerHTML = cacheItem.html;
      if (cacheItem.html) {
        attachWidgetEventHandlers(div, this.client, this.from);
      }
    }

    // Async kick-off of content renderer
    this.renderContent(div, cacheItem?.html).catch(console.error);
    this.dom = div;
    return div;
  }

  async renderContent(
    div: HTMLElement,
    cachedHtml: string | undefined,
  ) {
    let widgetContent = await this.callback(
      this.bodyText,
      this.client.currentPage,
    );
    activeWidgets.add(this);
    if (!widgetContent) {
      div.innerHTML = "";
      this.client.setWidgetCache(
        this.cacheKey,
        { height: div.clientHeight, html: "" },
      );
      return;
    }
    let html = "";
    if (typeof widgetContent !== "object") {
      // Return as markdown string or number
      widgetContent = { markdown: "" + widgetContent };
    }
    if (widgetContent.cssClasses) {
      div.className = widgetContent.cssClasses.join(" ");
    }
    if (widgetContent.html) {
      html = widgetContent.html;
      div.innerHTML = html;
      if ((widgetContent as any)?.display === "block") {
        div.style.display = "block";
      } else {
        div.style.display = "inline";
      }
      attachWidgetEventHandlers(div, this.client, this.from);
      this.client.setWidgetCache(
        this.cacheKey,
        { height: div.clientHeight, html },
      );
    } else if (widgetContent.markdown) {
      let mdTree = parse(
        extendedMarkdownLanguage,
        widgetContent.markdown!,
      );
      mdTree = await this.client.clientSystem.localSyscall(
        "system.invokeFunction",
        [
          "markdown.expandCodeWidgets",
          mdTree,
          this.client.currentPage,
        ],
      );
      const trimmedMarkdown = renderToText(mdTree).trim();

      if (!trimmedMarkdown) {
        // Net empty result after expansion
        div.innerHTML = "";
        this.client.setWidgetCache(
          this.cacheKey,
          { height: div.clientHeight, html: "" },
        );
        return;
      }

      if ((widgetContent as any)?.display === "block") {
        div.style.display = "block";
      } else {
        div.style.display = "inline";
      }

      // Parse the markdown again after trimming
      mdTree = parse(
        extendedMarkdownLanguage,
        trimmedMarkdown,
      );

      html = renderMarkdownToHtml(mdTree, {
        // Annotate every element with its position so we can use it to put
        // the cursor there when the user clicks on the table.
        annotationPositions: true,
        translateUrls: (url) => {
          if (isLocalPath(url)) {
            url = resolvePath(
              this.client.currentPage,
              decodeURI(url),
            );
          }

          return url;
        },
        preserveAttributes: true,
      }, this.client.ui.viewState.allPages);

      if (cachedHtml === html) {
        // HTML still same as in cache, no need to re-render
        return;
      }
      div.innerHTML = html;
      if (html) {
        attachWidgetEventHandlers(div, this.client, this.from);
      }
    }

    // Let's give it a tick, then measure and cache
    setTimeout(() => {
      this.client.setWidgetCache(
        this.cacheKey,
        {
          height: div.offsetHeight,
          html,
        },
      );
      // Because of the rejiggering of the DOM, we need to do a no-op cursor move to make sure it's positioned correctly
      this.client.editorView.dispatch({
        selection: {
          anchor: this.client.editorView.state.selection.main.anchor,
        },
      });
    });
  }

  override get estimatedHeight(): number {
    const cacheItem = this.client.getWidgetCache(this.cacheKey);
    return cacheItem ? cacheItem.height : -1;
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof LuaWidget &&
      other.bodyText === this.bodyText && other.cacheKey === this.cacheKey &&
      this.from === other.from
    );
  }
}
