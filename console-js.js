(() => {
  const VERSION = "1.10.0-turn-inventory";
  const errors = [];

  try {
    const transcript = [...document.querySelectorAll("div")]
      .filter(el =>
        [...el.classList].some(c => c.startsWith("transcriptContent-"))
      )
      .sort((a, b) =>
        (b.innerText?.length || 0) - (a.innerText?.length || 0)
      )[0];

    if (!transcript) {
      throw new Error("未找到 transcriptContent 容器");
    }

    const content = [...transcript.querySelectorAll("div.relative.shrink-0")]
      .sort((a, b) =>
        (b.innerText?.length || 0) - (a.innerText?.length || 0)
      )[0];

    if (!content) {
      throw new Error("未找到 relative.shrink-0 内容容器");
    }

    const textOf = el =>
      (el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

    const describe = (el, index = -1) => {
      const rect = el.getBoundingClientRect();
      const attrs = {};

      for (const name of [
        "data-testid",
        "data-message-author-role",
        "data-message-id",
        "data-turn-id",
        "data-virtualized-turn-content",
        "role",
        "aria-hidden"
      ]) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value;
      }

      return {
        index,
        tag: el.tagName,
        className: typeof el.className === "string"
          ? el.className.slice(0, 260)
          : "",
        attrs,
        textLength: textOf(el).length,
        textPreview: textOf(el).slice(0, 220),
        childCount: el.children.length,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: getComputedStyle(el).display,
        visibility: getComputedStyle(el).visibility,
        contentVisibility: getComputedStyle(el).contentVisibility
      };
    };

    const selectors = [
      ".group\\/user-message",
      ".group\\/assistant-message",
      ".MarkdownRoot-rZKhxa",
      '[data-message-author-role]',
      '[data-testid*="conversation-turn"]',
      "[data-virtualized-turn-content]",
      ".actionRow-nqqZbm"
    ];

    const inventories = {};

    for (const selector of selectors) {
      const nodes = [...content.querySelectorAll(selector)];

      inventories[selector] = {
        count: nodes.length,
        nodes: nodes.slice(0, 300).map((el, i) => {
          const item = describe(el, i);
          const parent = el.parentElement;

          item.parent = parent ? describe(parent) : null;
          item.grandparent = parent?.parentElement
            ? describe(parent.parentElement)
            : null;

          return item;
        })
      };
    }

    const structuralNodes = [
      ...content.querySelectorAll("div")
    ].filter(el => {
      const cls = typeof el.className === "string" ? el.className : "";
      return (
        cls.includes("flex flex-col") ||
        cls.includes("stack-") ||
        cls.includes("transcript") ||
        cls.includes("virtualized")
      );
    });

    const structuralInventory = structuralNodes
      .slice(0, 250)
      .map((el, i) => {
        const item = describe(el, i);
        item.children = [...el.children].slice(0, 12).map(child =>
          describe(child)
        );
        return item;
      });

    const allText = textOf(content);

    const result = {
      diagnostic: "ChatGPT DOM Turn Inventory",
      version: VERSION,
      timestamp: new Date().toISOString(),
      errors,
      page: {
        url: location.href,
        title: document.title
      },
      transcript: describe(transcript),
      content: describe(content),
      contentTextLength: allText.length,
      contentDirectChildren: [...content.children].map((el, i) =>
        describe(el, i)
      ),
      inventories,
      structuralInventory,
      documentCounts: {
        userMessages: document.querySelectorAll(".group\\/user-message").length,
        assistantMessages: document.querySelectorAll(".group\\/assistant-message").length,
        markdownRoots: document.querySelectorAll(".MarkdownRoot-rZKhxa").length,
        virtualizedTurns: document.querySelectorAll(
          "[data-virtualized-turn-content]"
        ).length
      }
    };

    console.log(
      "[ChatGPT DOM Turn Inventory]\n" +
      JSON.stringify(result, null, 2)
    );

  } catch (error) {
    errors.push({
      message: error.message,
      stack: error.stack
    });

    console.log(
      "[ChatGPT DOM Turn Inventory]\n" +
      JSON.stringify({
        diagnostic: "ChatGPT DOM Turn Inventory",
        version: VERSION,
        timestamp: new Date().toISOString(),
        errors
      }, null, 2)
    );
  }
})();
