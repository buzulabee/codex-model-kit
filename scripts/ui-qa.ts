// Headless Chromium against an isolated SDK host + actual bundled STDIO server.
// Does not automate Codex, touch daily config or make real inference requests.
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { diagnosticSchema } from "../src/shared/diagnostics.js";
import { build } from "esbuild";
import { resolve } from "node:path";
import { loopbackFixture, fixtureSecret } from "../tests/loopback-fixture.js";
import { DISPLAY_VERSION, VERSION } from "../src/shared/security.js";
const { chromium } = await import(
  process.env.MODEL_KIT_PLAYWRIGHT_MODULE ?? "playwright"
);
const hostBuild = await build({
  entryPoints: ["scripts/ui-host.ts"],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
});
const hostJs = hostBuild.outputFiles[0]!.text;
const html = await readFile(
  "dist/marketplace/plugins/codex-model-kit/main.html",
  "utf8",
);
const envAuth = process.env.MODEL_KIT_QA_AUTH === "env";
const fileSyncOnly = process.env.MODEL_KIT_QA_FILE_SYNC === "1";
let modelsStatus = 200;
const f = await loopbackFixture(
  async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/main.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:",
      );
      res.end(html);
    } else if (path === "/host.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(hostJs);
    } else if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><style>body{margin:0;background:#f4f7f8;height:100dvh;display:flex;flex-direction:column;overflow:hidden} .fixture-label{flex-shrink:0;background:#183c35;color:white;padding:8px 18px;font:13px system-ui}iframe{width:100%;flex:1;min-height:0;border:0;display:block}html[data-theme=dark] body{background:#171c20}</style></head><body><div class="fixture-label">离线自动验收 · 同一生产 UI + SDK 桥 + 真实 STDIO · 虚构连接/模型/密钥 · 不是真实中转站测试</div><iframe title="Codex 模型工具"></iframe><script type="module" src="/host.js"></script></body></html>`,
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  },
  {
    unknownModels: ["model-60"],
    probeDelayMs: 1600,
    delayedModel: "Edited-Request-ID",
    modelsStatus: () => modelsStatus,
    modelsDelayMs: 300,
    ...(envAuth ? { credentialMode: "env" as const } : {}),
  },
);
let browser;
const pageErrors: string[] = [];
const audit: string[] = [];
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1040 },
    locale: "zh-CN",
  });
  page.on("pageerror", () => pageErrors.push("browser-script-error"));
  await page.route("**/*", async (route: any) => {
    const url = route.request().url();
    if (!url.startsWith(f.origin + "/")) {
      audit.push("blocked-external");
      await route.abort();
    } else await route.continue();
  });
  await page.goto(f.origin + (fileSyncOnly ? "/?fileSyncOnly=1" : ""));
  const ui = page.frameLocator("iframe");
  const closeDialog = async () => {
    const preview = ui.getByRole("dialog", { name: "变更预览", exact: true });
    if (await preview.isVisible()) {
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
      await ui
        .getByRole("dialog", { name: "调整模型顺序", exact: true })
        .waitFor();
    }
    await page.keyboard.press("Escape");
  };
  const scrollTop = async () => {
    await ui.locator("body").evaluate(() => window.scrollTo(0, 0));
  };
  const expectVisible = async (locator: any) => {
    await locator.waitFor({ state: "visible", timeout: 12000 });
    if ((await locator.getAttribute("role")) === "dialog") {
      const close = locator.locator(".section-heading .icon-close");
      assert.equal(await close.count(), 1, "every dialog uses one close icon");
      assert.equal(await close.innerText(), "");
      assert.equal(await close.locator('svg[aria-hidden="true"]').count(), 1);
      assert(await close.getAttribute("aria-label"));
      assert.equal(await close.getAttribute("title"), "关闭");
    }
  };
  await expectVisible(
    ui.getByRole("heading", { name: "CODEX MODEL KIT", exact: true }),
  );
  await expectVisible(
    ui.getByText("已读取本地模型目录 · 2 个本地模型", { exact: true }),
  );
  const visibleModelIds = () =>
    ui.locator("tbody tr:not(.group-row) .model-id").allTextContents();
  assert.deepEqual(await visibleModelIds(), ["Fixture-Pass", "Local-Missing"]);
  assert.equal(await ui.locator(".header-brand .icon-button").count(), 1);
  assert.equal(
    await ui.locator("header .version").innerText(),
    DISPLAY_VERSION,
  );
  assert.equal(
    await ui
      .locator(".app-bottom-space")
      .evaluate((el: any) => getComputedStyle(el).minHeight),
    "64px",
  );
  await ui
    .locator(".app-bottom-space")
    .evaluate((el: any) => el.scrollIntoView({ block: "end" }));
  assert(
    await ui.locator(".footer-actions").evaluate((el: any) => {
      const bottom = el.getBoundingClientRect().bottom;
      return bottom <= window.innerHeight - 50;
    }),
    "footer actions should clear a 50px bottom-right host overlay",
  );
  await page.screenshot({
    path: resolve(".test-artifacts/host-clearance.png"),
  });
  await ui.locator("body").evaluate(() => window.scrollTo(0, 0));
  assert.equal(
    await ui
      .locator(".eyebrow")
      .evaluate((el: any) => getComputedStyle(el).fontSize),
    "20px",
  );
  assert.equal(
    await ui.locator("h1").evaluate((el: any) => getComputedStyle(el).fontSize),
    "11px",
  );
  assert.equal(await ui.getByRole("button", { name: /全屏/ }).count(), 0);
  assert.equal(
    await ui.getByText("只读 · 密钥不展示", { exact: true }).count(),
    0,
  );
  assert.deepEqual(await ui.locator(".status-grid label").allTextContents(), [
    "base_url",
    envAuth ? "env_key（环境变量）" : "experimental_bearer_token",
    "model_catalog_json",
    "连接状态",
  ]);
  await ui.getByRole("button", { name: "使用说明", exact: true }).click();
  const help = ui.getByRole("dialog", { name: "使用说明", exact: true });
  await expectVisible(help);
  await expectVisible(
    help.getByText("同步中转站的模型变化，只管理模型目录，不改连接配置。", {
      exact: true,
    }),
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-help.png"),
  });
  await help.getByRole("button", { name: "关闭使用说明", exact: true }).click();
  assert.equal(
    await ui
      .getByRole("button", { name: "使用说明", exact: true })
      .evaluate((el: any) => el === document.activeElement),
    true,
  );
  assert.equal(f.records.length, 0, "opening reads files only");
  const assertHeaders = async () => {
    assert.equal(
      (await ui.locator("th.capability-column").innerText()).replace(
        /\s+/g,
        " ",
      ),
      "上下文 / 思考 / 图片",
    );
    assert.equal(await ui.locator("th.settings-column").innerText(), "设置");
  };
  const capabilityLayout = async () => {
    const layouts = [];
    for (const width of [1280, 900, 650, 430, 390, 360]) {
      await page.setViewportSize({ width, height: 950 });
      layouts.push(
        await ui
          .locator("tbody tr")
          .filter({
            has: ui.getByRole("checkbox", {
              name: "选择 Local Pass Alias",
              exact: true,
            }),
          })
          .evaluate((row: any) => {
            const cell = row.children[2];
            return {
              bounds: [
                cell,
                cell.querySelector("strong"),
                cell.querySelector(".image-badge"),
                cell.querySelector(".reasoning-levels"),
              ].map((el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x, width: r.width, height: r.height };
              }),
              text: cell.textContent,
            };
          }),
      );
    }
    await page.setViewportSize({ width: 1280, height: 1040 });
    return layouts;
  };
  const initialCapabilityLayout = await capabilityLayout();
  await assertHeaders();
  await page.setViewportSize({ width: 390, height: 950 });
  await assertHeaders();
  await expectVisible(ui.locator("tbody .reasoning-levels").first());
  const beforeReloadHeight = await ui
    .locator("main")
    .evaluate((el: any) => el.scrollHeight);
  await ui.getByRole("button", { name: "重新读取配置", exact: true }).click();
  await expectVisible(
    ui.locator(".toast").getByText("已重新读取配置；内存草稿已重置。", {
      exact: true,
    }),
  );
  assert.equal(
    await ui.locator("main").evaluate((el: any) => el.scrollHeight),
    beforeReloadHeight,
    "reload tip must not change the page layout",
  );
  assert.deepEqual(await visibleModelIds(), ["Fixture-Pass", "Local-Missing"]);
  await assertHeaders();
  assert.equal(
    f.records.length,
    0,
    "reload must not request provider or inference",
  );
  await expectVisible(ui.locator("tbody .reasoning-levels").first());
  await page.setViewportSize({ width: 1280, height: 1040 });

  assert.equal(await ui.locator('input[type="password"]').count(), 0);
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 Local Pass Alias", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 Local Missing", exact: true })
      .isChecked(),
    true,
  );
  await ui
    .getByText("配置指引 / 选择其他已配置的 provider", { exact: true })
    .click();
  const provider = ui.getByRole("combobox", { name: "已配置连接" });
  const id = await provider.locator("option").nth(1).getAttribute("value");
  await provider.selectOption(id);
  await ui.getByRole("checkbox", { name: /如使用 HTTP/ }).check();
  await ui.getByRole("button", { name: "使用已有配置", exact: true }).click();
  await expectVisible(ui.getByText("配置完整 · 网络待检查", { exact: true }));
  await ui.getByRole("button", { name: "刷新供应商模型", exact: true }).click();
  assert.equal(
    await ui.locator(".toast").count(),
    0,
    "refresh must await completion",
  );
  await expectVisible(ui.getByText("模型列表接口正常", { exact: true }));
  await expectVisible(
    ui
      .locator(".toast")
      .getByText("供应商模型已刷新，共 69 个。", { exact: true }),
  );
  await page.screenshot({ path: resolve(".test-artifacts/refresh-toast.png") });
  await ui.getByRole("button", { name: "关闭提示", exact: true }).click();
  assert.equal(await ui.locator(".toast").count(), 0);
  assert.deepEqual((await visibleModelIds()).slice(0, 2), [
    "Fixture-Pass",
    "Local-Missing",
  ]);
  await assertHeaders();
  const refreshedCapabilityLayout = await capabilityLayout();
  await writeFile(
    resolve(".test-artifacts/initial-refresh-layout.json"),
    JSON.stringify(
      { initialCapabilityLayout, refreshedCapabilityLayout },
      null,
      2,
    ),
  );
  assert.deepEqual(
    initialCapabilityLayout,
    refreshedCapabilityLayout,
    "local capabilities must keep the refreshed layout on first load",
  );
  await expectVisible(
    ui.getByText(
      `已配置（${fixtureSecret.slice(0, 3)}***${fixtureSecret.slice(-3)}）`,
      { exact: true },
    ),
  );
  assert(!(await ui.locator("body").innerText()).includes(fixtureSecret));
  await expectVisible(
    ui.getByText(
      envAuth
        ? "已复用 env_key 指定的环境变量；只显示脱敏片段。"
        : "已复用显式 Bearer；只显示脱敏片段。",
      { exact: true },
    ),
  );
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择全部筛选模型" })
      .evaluate((el: any) => el.indeterminate),
    true,
  );
  assert.equal(f.records.filter((r) => r.method === "GET").length, 1);
  assert.equal(f.records.filter((r) => r.method === "POST").length, 0);
  await expectVisible(
    ui.getByText("本地模型 · 本次未在供应商列表返回", { exact: true }),
  );
  const local = ui.locator("tbody tr").filter({
    has: ui.getByRole("checkbox", {
      name: "选择 Local Pass Alias",
      exact: true,
    }),
  });
  assert.match(await local.innerText(), /64K/);
  assert.match(await local.innerText(), /文本/);
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 Fixture-Quota", exact: true })
      .isChecked(),
    false,
  );
  const search = ui.getByRole("searchbox", { name: "搜索模型" });
  await expectVisible(
    ui.getByText("供应商其他模型 · 本地未配置", { exact: true }),
  );
  // Reserve real, non-overlay scrollbar space rather than relying on macOS defaults.
  const scrollbarAudit: unknown[] = [];
  for (const gutter of [12, 18, 24]) {
    await ui.locator("body").evaluate((el: any, width: number) => {
      const style = document.createElement("style");
      style.id = "qa-scrollbar";
      style.textContent = `.table-scroll { max-height: 200px; } .table-scroll::-webkit-scrollbar { width: ${width}px; height: ${width}px; }`;
      el.appendChild(style);
    }, gutter);
    for (const width of [1280, 900, 650, 430, 390, 360]) {
      await page.setViewportSize({ width, height: 950 });
      await search.fill("");
      await expectVisible(ui.locator("tbody .reasoning-levels").first());
      const metrics = await ui.locator(".table-scroll").evaluate((el: any) => {
        el.scrollTop = 0;
        const check = el.querySelector("thead input").getBoundingClientRect();
        const checkCell = el.querySelector("thead th").getBoundingClientRect();
        const button = el
          .querySelector("tbody .icon-button")
          .getBoundingClientRect();
        const buttonCell = el
          .querySelector("tbody .icon-button")
          .closest("td")
          .getBoundingClientRect();
        return {
          client: el.clientWidth,
          scroll: el.scrollWidth,
          gutter: el.offsetWidth - el.clientWidth - 2,
          vertical: el.scrollHeight > el.clientHeight,
          left: check.left - checkCell.left,
          right: buttonCell.right - button.right,
          bodyOverflow:
            document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert(
        metrics.vertical,
        `fixture must need vertical scrolling at ${width}`,
      );
      assert.equal(
        metrics.gutter,
        gutter,
        "non-overlay scrollbar must really reserve space",
      );
      assert(
        metrics.scroll <= metrics.client,
        `horizontal overflow at ${width}/${gutter}: ${JSON.stringify(metrics)}`,
      );
      assert(!metrics.bodyOverflow, `page overflow at ${width}/${gutter}`);
      assert(
        metrics.left >= 11 && metrics.right >= 11,
        `table edge spacing at ${width}/${gutter}`,
      );
      await search.fill("model-00");
      assert.equal(
        await ui.locator(".table-scroll").evaluate((el: any) => el.clientWidth),
        metrics.client,
        "appearing/disappearing vertical scrollbar must not shift columns",
      );
      scrollbarAudit.push({ width, scrollbarWidth: gutter, ...metrics });
    }
    if (gutter === 18) {
      await search.fill("");
      await scrollTop();
      await page.screenshot({
        path: resolve(".test-artifacts/order-ui-scrollbar.png"),
      });
    }
    await ui.locator("#qa-scrollbar").evaluate((el: any) => el.remove());
  }
  await page.setViewportSize({ width: 1280, height: 1040 });
  await search.fill("");
  const previewButton = ui.getByRole("button", {
    name: "更新模型列表",
    exact: true,
  });
  const orderDialog = ui.getByRole("dialog", {
    name: "调整模型顺序",
    exact: true,
  });
  const preview = ui.getByRole("dialog", { name: "变更预览", exact: true });
  const previewCalls = () =>
    f.toolRecords.filter((r: any) => r?.name === "prepare_catalog_write")
      .length;
  const confirmOrder = async () => {
    await expectVisible(orderDialog);
    assert(
      await orderDialog.evaluate((el: any) => el.scrollWidth <= el.clientWidth),
    );
    await orderDialog
      .getByRole("button", { name: "预览变更", exact: true })
      .click();
    await expectVisible(
      ui.getByRole("dialog").locator("textarea, .preview-issues"),
    );
    assert.equal(await ui.getByRole("dialog").count(), 1);
    if (await preview.isVisible()) {
      assert.equal(
        await orderDialog.count(),
        0,
        "preview must replace, not expand ordering",
      );
      assert.equal(await preview.locator(".order-list").count(), 0);
    }
  };
  const beforeOrderCalls = previewCalls();
  await previewButton.click();
  await expectVisible(orderDialog);
  await expectVisible(
    orderDialog.getByText(
      "写入模型目录 JSON 后，需重启 Codex 客户端，模型列表及顺序变更才会生效。",
      { exact: true },
    ),
  );
  assert.equal(await orderDialog.locator("li").count(), 2);
  const originalOrder = await orderDialog
    .locator("li .model-id")
    .allTextContents();
  await orderDialog
    .getByRole("button", { name: "置顶 Local Missing", exact: true })
    .click();
  assert.equal(
    (await orderDialog.locator("li .model-id").allTextContents())[0],
    "Local-Missing",
  );
  await closeDialog();
  assert.equal(
    previewCalls(),
    beforeOrderCalls,
    "cancelled ordering cannot generate a preview",
  );
  assert.equal(
    await previewButton.evaluate((el: any) => el === document.activeElement),
    true,
  );
  await previewButton.click();
  await expectVisible(orderDialog);
  assert.deepEqual(
    await orderDialog.locator("li .model-id").allTextContents(),
    originalOrder,
    "cancel leaves confirmed order unchanged",
  );
  await orderDialog
    .getByRole("button", { name: "置顶 Local Missing", exact: true })
    .click();
  assert.equal(
    await orderDialog
      .getByRole("button", { name: "上移 Local Missing", exact: true })
      .isEnabled(),
    false,
  );
  await orderDialog
    .getByRole("button", { name: "下移 Local Missing", exact: true })
    .click();
  await orderDialog
    .getByRole("button", { name: "上移 Local Missing", exact: true })
    .click();
  await orderDialog
    .getByRole("button", { name: "置底 Local Missing", exact: true })
    .click();
  await orderDialog
    .getByRole("button", { name: "置顶 Local Missing", exact: true })
    .click();
  for (const width of [1280, 900, 650, 430, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    assert(
      await orderDialog.evaluate((el: any) => el.scrollWidth <= el.clientWidth),
    );
    await expectVisible(orderDialog.locator("#catalog-restart-notice"));
  }
  await page.setViewportSize({ width: 390, height: 950 });
  await page.screenshot({ path: resolve(".test-artifacts/order-ui-sort.png") });
  await confirmOrder();
  await expectVisible(preview);
  for (const width of [1280, 900, 650, 430, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    const footer = await preview
      .locator(".catalog-actions")
      .evaluate((el: any) => {
        const bounds = el.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          buttons: Array.from(el.querySelectorAll("button"), (button: any) => {
            const r = button.getBoundingClientRect();
            return {
              text: button.textContent,
              left: r.left,
              right: r.right,
              top: r.top,
            };
          }),
        };
      });
    assert.deepEqual(
      footer.buttons.map((b: any) => b.text),
      ["全选 JSON", "返回调整顺序", "确认写入"],
    );
    for (const [index, button] of footer.buttons.entries()) {
      assert(
        Math.abs(button.top - footer.buttons[0].top) < 1,
        `footer row at ${width}px`,
      );
      assert(
        button.left >= footer.left && button.right <= footer.right,
        `footer bounds at ${width}px`,
      );
      if (index)
        assert(
          button.left >= footer.buttons[index - 1].right,
          `footer overlap at ${width}px`,
        );
    }
  }
  await preview.getByRole("button", { name: "全选 JSON", exact: true }).click();
  assert(
    await preview
      .locator("textarea")
      .evaluate(
        (el: any) =>
          el === document.activeElement &&
          el.selectionStart === 0 &&
          el.selectionEnd === el.value.length,
      ),
  );
  await page.screenshot({
    path: resolve(".test-artifacts/preview-footer-360.png"),
  });
  await page.setViewportSize({ width: 390, height: 950 });
  const sortedPreview = JSON.parse(
    await preview.getByRole("textbox", { name: "模型目录 JSON" }).inputValue(),
  );
  assert.deepEqual(
    sortedPreview.models.map((m: any) => m.slug),
    ["Local-Missing", "Fixture-Pass"],
  );
  assert.deepEqual(
    sortedPreview.models.map((m: any) => m.priority),
    [0, 1],
  );
  await preview
    .getByRole("button", { name: "关闭变更预览", exact: true })
    .click();
  await expectVisible(orderDialog);
  assert.equal(await orderDialog.locator("textarea").count(), 0);
  assert.deepEqual(
    await orderDialog.locator("li .model-id").allTextContents(),
    ["Local-Missing", "Fixture-Pass"],
  );
  assert.equal(
    await orderDialog
      .getByRole("button", { name: "预览变更", exact: true })
      .evaluate((el: any) => el === document.activeElement),
    true,
  );
  await closeDialog();
  assert.equal(
    await previewButton.evaluate((el: any) => el === document.activeElement),
    true,
    "preview restores the original ordering opener",
  );
  await page.setViewportSize({ width: 1280, height: 1040 });
  await previewButton.click();
  await expectVisible(orderDialog);
  assert.equal(
    (await orderDialog.locator("li .model-id").allTextContents())[0],
    "Local-Missing",
    "confirmed ordering is remembered",
  );
  await orderDialog
    .getByRole("button", { name: "关闭顺序调整", exact: true })
    .click();

  // Seven known models are valid; an unknown seventh must explain exactly what is missing.
  const known = ["model-00", "model-01", "model-02", "model-03", "model-04"];
  for (const id of known) {
    await search.fill(id);
    await ui.getByRole("checkbox", { name: `选择 ${id}`, exact: true }).check();
  }
  await search.fill("model-00");
  await ui
    .getByRole("button", { name: "编辑 model-00 参数", exact: true })
    .click();
  const defaultEditor = ui.getByRole("dialog", { name: "模型参数编辑" });
  await expectVisible(defaultEditor);
  assert.equal(
    await defaultEditor
      .getByRole("combobox", { name: "默认思考等级", exact: true })
      .inputValue(),
    "medium",
  );
  await closeDialog();
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  assert.equal(
    JSON.parse(
      await preview
        .getByRole("textbox", { name: "模型目录 JSON" })
        .inputValue(),
    ).models.length,
    7,
  );
  const defaultModels = JSON.parse(
    await preview.getByRole("textbox", { name: "模型目录 JSON" }).inputValue(),
  ).models;
  for (const id of known)
    assert.equal(
      defaultModels.find((model: any) => model.slug === id)
        .default_reasoning_level,
      "medium",
    );
  assert.equal(
    defaultModels.find((model: any) => model.slug === "Fixture-Pass")
      .default_reasoning_level,
    "low",
  );
  await closeDialog();
  await search.fill("model-04");
  await ui
    .getByRole("checkbox", { name: "选择 model-04", exact: true })
    .uncheck();
  await search.fill("model-60");
  await ui
    .getByRole("checkbox", { name: "选择 model-60", exact: true })
    .check();
  const beforeInvalidWrite = await readFile(f.catalogPath, "utf8");
  const preparedBeforeInvalid = f.toolRecords.filter(
    (r: any) =>
      r.name === "prepare_catalog_write" || r.name === "commit_catalog_write",
  ).length;
  await previewButton.click();
  const problem = ui.getByRole("dialog", {
    name: "未写入：请完善模型参数",
    exact: true,
  });
  await expectVisible(problem);
  assert.equal(
    await orderDialog.count(),
    0,
    "invalid parameters block ordering",
  );
  await expectVisible(
    problem.getByRole("heading", {
      name: "未写入：请完善模型参数",
      exact: true,
    }),
  );
  assert.equal(await problem.getByText(/没有模型被静默移除/).count(), 0);
  await expectVisible(
    problem.getByText(/已选 7 个模型，其中 1 个需要确认参数/),
  );
  await expectVisible(
    problem.getByText("上下文窗口未知；图片支持未知", { exact: true }),
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-preview-problem.png"),
  });
  for (const width of [1280, 900, 650, 430, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    assert(
      await problem
        .locator(".preview-issues li")
        .evaluateAll((items: Element[]) =>
          items.every((item) => {
            const [name, reason, edit] = Array.from(item.children).map((el) =>
              el.getBoundingClientRect(),
            );
            const row = item.getBoundingClientRect();
            return (
              name &&
              reason &&
              edit &&
              name.width > 0 &&
              reason.width > 0 &&
              edit.width === 30 &&
              name.right <= reason.left &&
              reason.right <= edit.left &&
              Math.abs(name.y + name.height / 2 - edit.y - edit.height / 2) <
                1 &&
              Math.abs(
                reason.y + reason.height / 2 - edit.y - edit.height / 2,
              ) < 1 &&
              name.left >= row.left &&
              edit.right <= row.right
            );
          }),
        ),
      `problem rows keep name, reason and edit icon aligned at ${width}px`,
    );
    const edit = problem.getByRole("button", {
      name: "编辑 model-60 参数",
      exact: true,
    });
    assert.equal(await edit.innerText(), "");
    assert.equal(await edit.getAttribute("title"), "编辑参数");
    assert.equal(await edit.locator('svg[aria-hidden="true"]').count(), 1);
  }
  await page.screenshot({
    path: resolve(".test-artifacts/validation-problem-360.png"),
  });
  await problem
    .getByRole("button", { name: "关闭写入提示", exact: true })
    .click();
  await problem.waitFor({ state: "hidden" });
  assert.equal(
    await previewButton.evaluate((el: any) => el === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 1040 });
  await previewButton.click();
  await expectVisible(problem);
  assert.equal(await orderDialog.count(), 0);
  await problem
    .getByRole("button", { name: "编辑 model-60 参数", exact: true })
    .click();
  const unknownEditor = ui.getByRole("dialog", { name: "模型参数编辑" });
  await expectVisible(unknownEditor);
  await unknownEditor
    .getByRole("textbox", { name: "上下文窗口", exact: true })
    .fill("128K");
  await unknownEditor
    .getByRole("button", { name: "保存参数草稿", exact: true })
    .click();
  await previewButton.click();
  await expectVisible(problem);
  assert.equal(await orderDialog.count(), 0, "unknown images block ordering");
  await expectVisible(problem.getByText("图片支持未知", { exact: true }));
  assert.equal(await readFile(f.catalogPath, "utf8"), beforeInvalidWrite);
  assert.equal(
    f.toolRecords.filter(
      (r: any) =>
        r.name === "prepare_catalog_write" || r.name === "commit_catalog_write",
    ).length,
    preparedBeforeInvalid,
    "invalid parameters never prepare or commit a write",
  );
  await problem
    .getByRole("button", { name: "编辑 model-60 参数", exact: true })
    .click();
  await expectVisible(unknownEditor);
  await unknownEditor
    .getByRole("combobox", { name: "图片输入", exact: true })
    .selectOption("false");
  await unknownEditor
    .getByRole("button", { name: "保存参数草稿", exact: true })
    .click();
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  assert.equal(
    JSON.parse(
      await preview
        .getByRole("textbox", { name: "模型目录 JSON" })
        .inputValue(),
    ).models.length,
    7,
  );
  await closeDialog();
  for (const id of [...known.slice(0, 4), "model-60"]) {
    await search.fill(id);
    await ui
      .getByRole("checkbox", { name: `选择 ${id}`, exact: true })
      .uncheck();
  }
  await search.fill("");
  assert.equal(f.records.filter((r) => r.method === "POST").length, 0);
  await search.fill("<b>literal-id</b>");
  await expectVisible(
    ui.getByText("<b>literal-id</b>", { exact: true }).first(),
  );
  assert.equal(await ui.locator("tbody b").count(), 0, "model HTML is escaped");
  await search.fill("__proto__");
  const prototypeModel = ui.getByRole("checkbox", {
    name: "选择 __proto__",
    exact: true,
  });
  await prototypeModel.check();
  assert.equal(await prototypeModel.isChecked(), true);
  await prototypeModel.uncheck();
  await search.fill("constructor");
  const constructorModel = ui.getByRole("checkbox", {
    name: "选择 constructor",
    exact: true,
  });
  await constructorModel.check();
  assert.equal(await constructorModel.isChecked(), true);
  await constructorModel.uncheck();
  await search.fill("");
  await ui.getByRole("button", { name: "下一页", exact: true }).click();
  await expectVisible(ui.getByText(/第 2 \/ 2 页/));
  assert.equal(await ui.locator("tbody input[type=checkbox]").count(), 20);
  await ui.getByRole("button", { name: "上一页", exact: true }).click();
  await expectVisible(local);
  assert.equal(await local.getByRole("checkbox").isChecked(), true);
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-desktop.png"),
  });
  await local
    .getByRole("button", { name: "编辑 Local Pass Alias 参数", exact: true })
    .click();
  await ui
    .getByRole("textbox", { name: "菜单显示名称", exact: true })
    .fill("My Relay Coding");
  await ui
    .getByRole("textbox", { name: "实际请求模型", exact: true })
    .fill("Edited-Request-ID");
  const contextInput = ui.getByRole("textbox", {
    name: "上下文窗口",
    exact: true,
  });
  await contextInput.fill("256K");
  await ui.getByRole("button", { name: "增加上下文窗口", exact: true }).click();
  assert.equal(await contextInput.inputValue(), "272K");
  await ui.getByRole("button", { name: "减少上下文窗口", exact: true }).click();
  assert.equal(await contextInput.inputValue(), "256K");
  await contextInput.fill("bad");
  await ui.getByRole("button", { name: "保存参数草稿", exact: true }).click();
  await expectVisible(ui.getByRole("dialog").getByRole("alert"));
  await contextInput.fill("256K");
  assert.equal(await ui.getByRole("slider").count(), 0);
  const editor = ui.getByRole("dialog", { name: "模型参数编辑" });
  await expectVisible(editor);
  assert.equal(
    await editor.getByRole("button", { name: "取消", exact: true }).count(),
    0,
  );
  assert.equal(
    await editor
      .getByRole("button", { name: "关闭参数编辑", exact: true })
      .count(),
    1,
  );
  assert.deepEqual(
    await editor.locator(".effort-grid label").allTextContents(),
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  const effortBoxes = await editor
    .locator(".effort-grid label")
    .evaluateAll((items: Element[]) =>
      items.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y };
      }),
    );
  for (let i = 1; i < effortBoxes.length; i++)
    assert(
      effortBoxes[i].y > effortBoxes[i - 1].y ||
        effortBoxes[i].x > effortBoxes[i - 1].x,
    );
  const editorRect = await editor.boundingBox();
  assert(
    editorRect && editorRect.y >= 0 && editorRect.y + editorRect.height <= 1040,
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-editor.png"),
  });
  await editor.getByRole("checkbox", { name: "high", exact: true }).check();
  await ui
    .getByRole("combobox", { name: "默认思考等级", exact: true })
    .selectOption("high");
  await ui
    .getByRole("combobox", { name: "图片输入", exact: true })
    .selectOption("true");
  await ui.getByRole("button", { name: "保存参数草稿", exact: true }).click();
  const edited = ui.locator("tbody tr").filter({
    has: ui.getByRole("checkbox", {
      name: "选择 My Relay Coding",
      exact: true,
    }),
  });
  await expectVisible(edited);
  await ui.getByRole("button", { name: "更新模型列表", exact: true }).click();
  await confirmOrder();
  await expectVisible(preview);
  const json = JSON.parse(
    await preview.getByRole("textbox", { name: "模型目录 JSON" }).inputValue(),
  );
  assert.equal(json.models.length, 2);
  assert.equal(json.custom_top, "preserve top");
  const entry = json.models.find((m: any) => m.slug === "Edited-Request-ID");
  assert.equal(entry.display_name, "My Relay Coding");
  assert.equal(entry.context_window, 256000);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  assert.equal(entry.default_reasoning_level, "high");
  assert.equal(entry.custom_local, "preserve this");
  assert.equal(
    entry.model_messages.instructions_template,
    "Keep my local instructions",
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-preview.png"),
  });
  await preview.getByRole("button", { name: "确认写入", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await preview
      .getByRole("button", { name: "关闭变更预览", exact: true })
      .evaluate((el: any) => el === document.activeElement),
    true,
  );
  await closeDialog();
  await preview.waitFor({ state: "hidden" });
  // A cancelled confirmation emits no inference and creates no duplicate UI row.
  await edited.getByRole("button", { name: /检测直连/ }).click();
  const confirm = ui.getByRole("dialog", { name: "确认直连检测" });
  await expectVisible(confirm);
  assert.equal(
    await confirm
      .getByRole("button", { name: "关闭直连检测", exact: true })
      .locator("svg")
      .count(),
    1,
  );
  assert(!/费用|计费/.test(await confirm.innerText()));
  assert((await confirm.innerText()).includes("消耗 token"));
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-confirm.png"),
  });

  assert.equal(
    await confirm
      .getByRole("button", { name: "确认并测试", exact: true })
      .isEnabled(),
    true,
  );
  await closeDialog();
  await confirm.waitFor({ state: "hidden" });
  assert.equal(f.records.filter((r) => r.method === "POST").length, 0);
  assert.equal(
    await ui
      .locator("tbody tr")
      .filter({ hasText: "Edited-Request-ID" })
      .count(),
    1,
  );
  await edited.getByRole("button", { name: /检测直连/ }).click();
  await expectVisible(confirm);
  assert.equal(await confirm.getByRole("checkbox").count(), 0);
  await confirm
    .getByRole("button", { name: "确认并测试", exact: true })
    .dblclick();
  await expectVisible(edited.getByText("测试中...", { exact: true }));
  await expectVisible(edited.getByText("通过", { exact: true }));
  assert.equal(
    await edited
      .getByText("Responses 基础流式检测通过。", { exact: true })
      .count(),
    0,
  );
  assert.equal(f.records.filter((r) => r.method === "POST").length, 1);
  assert.equal(
    f.records.find((r) => r.method === "POST")?.model,
    "Edited-Request-ID",
  );
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 My Relay Coding", exact: true })
      .isChecked(),
    true,
  );
  await expectVisible(edited.getByText("256K", { exact: true }));
  await edited.getByRole("button", { name: /检测直连/ }).click();
  const details = confirm;
  await confirm.locator("summary").click();
  await expectVisible(details);
  await expectVisible(
    details.getByText("Responses 基础流式检测通过。", { exact: true }),
  );
  await closeDialog();
  await edited.getByRole("button", { name: /检测直连/ }).click();
  await expectVisible(confirm);
  await confirm
    .getByRole("button", { name: "确认并测试", exact: true })
    .click();
  await expectVisible(edited.getByText("测试中...", { exact: true }));
  assert.equal(await edited.getByText("通过", { exact: true }).count(), 0);
  await expectVisible(edited.getByText("通过", { exact: true }));
  for (const [id, label, reason] of [
    ["Fixture-Quota", "无法确认", "额度不足"],
    ["Fixture-FakeStream", "不满足直连", "普通 JSON"],
  ] as const) {
    const row = ui.locator("tbody tr").filter({
      has: ui.getByRole("checkbox", { name: `选择 ${id}`, exact: true }),
    });
    await row.getByRole("button", { name: /检测直连/ }).click();
    await expectVisible(confirm);
    await confirm
      .getByRole("button", { name: "确认并测试", exact: true })
      .click();
    await expectVisible(row.getByText(label, { exact: true }));
    assert.equal(await row.getByText(/本次无法确认/).count(), 0);
    await row.getByRole("button", { name: /检测直连/ }).click();
    await expectVisible(details);
    await expectVisible(details.getByText(new RegExp(reason)).first());
    if (id === "Fixture-Quota")
      await page.screenshot({
        path: resolve(".test-artifacts/order-ui-test-details.png"),
      });
    await closeDialog();
  }
  assert.equal(f.records.filter((r) => r.method === "POST").length, 4);
  // GET refresh/polling must not reset editing or selections.
  await ui
    .getByRole("checkbox", { name: "选择 Fixture-Quota", exact: true })
    .check();
  await ui.getByRole("button", { name: "刷新供应商模型", exact: true }).click();
  await expectVisible(ui.getByText("模型列表接口正常", { exact: true }));
  await assertHeaders();
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 Fixture-Quota", exact: true })
      .isChecked(),
    true,
  );
  await expectVisible(edited.getByText("256K", { exact: true }));
  await ui.getByRole("checkbox", { name: "只看已选", exact: true }).check();
  assert.equal(await ui.locator("tbody input[type=checkbox]").count(), 3);
  await ui.getByRole("checkbox", { name: "只看已选", exact: true }).uncheck();
  await page.evaluate(() => (window as any).fixtureTheme("dark"));
  await scrollTop();
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 950 });
  await scrollTop();
  assert.equal(
    await ui
      .locator("body")
      .evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    true,
  );
  assert.equal(
    await ui
      .locator(".table-scroll")
      .evaluate((el: any) => el.scrollWidth <= el.clientWidth),
    true,
  );
  assert.equal(
    await ui.locator("tbody .reasoning-levels").first().isVisible(),
    true,
  );
  await ui.locator("tbody .icon-button").first().click();
  const narrowEditor = ui.getByRole("dialog", { name: "模型参数编辑" });
  assert.equal(
    await narrowEditor.evaluate((el: any) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-narrow-editor.png"),
  });
  await closeDialog();
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-narrow.png"),
  });
  await ui.getByRole("button", { name: "更新模型列表", exact: true }).click();
  await confirmOrder();
  await expectVisible(preview);
  const rect = await preview.boundingBox();
  assert(
    rect &&
      rect.x >= 0 &&
      rect.x + rect.width <= 390 &&
      rect.y + rect.height <= 950,
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-narrow-preview.png"),
  });
  await closeDialog();
  assert.equal(f.records.filter((r) => r.method === "POST").length, 4);
  // All rows across pages may be selected; preparing/cancelling one bulk
  // confirmation must not POST. Then verify >10 requests with one confirmation.
  await page.setViewportSize({ width: 1280, height: 1040 });
  await search.fill("");
  await ui
    .getByRole("checkbox", { name: "选择全部筛选模型", exact: true })
    .check();
  await ui.getByRole("button", { name: /^测试已选直连/ }).click();
  await expectVisible(confirm);
  assert.equal(await confirm.getByRole("checkbox").count(), 0);
  await expectVisible(confirm.getByText(/发送 70 次/));
  await closeDialog();
  await confirm.waitFor({ state: "hidden" });
  assert.equal(f.records.filter((r) => r.method === "POST").length, 4);
  await ui
    .getByRole("checkbox", { name: "选择全部筛选模型", exact: true })
    .uncheck();

  assert.equal(await previewButton.isEnabled(), false);
  assert.equal(
    await previewButton.getAttribute("title"),
    "请先勾选至少一个模型",
  );

  await search.fill("model-");
  await ui
    .getByRole("checkbox", { name: "选择全部筛选模型", exact: true })
    .check();
  await ui
    .getByRole("button", { name: "测试已选直连（61）", exact: true })
    .click();
  await expectVisible(confirm);
  await expectVisible(confirm.getByText(/发送 61 次/));
  await confirm
    .getByRole("button", { name: "确认并测试", exact: true })
    .dblclick();
  await confirm.waitFor({ state: "hidden" });
  await ui
    .getByRole("button", { name: "取消检测", exact: true })
    .waitFor({ state: "hidden", timeout: 30000 });
  const posts = f.records.filter((r) => r.method === "POST");
  assert.equal(posts.length, 65);
  assert.equal(new Set(posts.map((r) => r.model)).size, 64);
  assert.equal(await ui.getByText("通过", { exact: true }).count(), 50);
  assert.equal(await ui.getByText(/不等于完整 Codex 兼容认证/).count(), 0);
  assert.equal(await previewButton.isEnabled(), true);
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  const bulkModels = JSON.parse(
    await preview.getByRole("textbox", { name: "模型目录 JSON" }).inputValue(),
  ).models;
  assert.equal(bulkModels.length, 61);
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-many-preview.png"),
  });
  await closeDialog();
  const addButton = ui.getByRole("button", {
    name: "手动添加模型",
    exact: true,
  });
  const manual = ui.getByRole("dialog", { name: "手动添加模型", exact: true });
  const manualCalls = () =>
    f.toolRecords.filter((r: any) => r?.name === "add_manual_model").length;
  const callsBefore = manualCalls();
  await addButton.click();
  await expectVisible(manual);
  for (const name of ["菜单显示名称", "实际请求模型", "上下文窗口"])
    await expectVisible(manual.getByRole("textbox", { name, exact: true }));
  for (const name of ["默认思考等级", "图片输入"])
    await expectVisible(manual.getByRole("combobox", { name, exact: true }));
  await manual
    .getByRole("button", { name: "添加模型草稿", exact: true })
    .click();
  await expectVisible(manual.getByRole("alert"));
  assert.equal(
    manualCalls(),
    callsBefore,
    "invalid add must not register a model",
  );
  await manual
    .getByRole("textbox", { name: "菜单显示名称", exact: true })
    .fill("Cancelled hidden model");
  await manual
    .getByRole("textbox", { name: "实际请求模型", exact: true })
    .fill("Cancelled-Hidden");
  await closeDialog();
  await search.fill("Cancelled-Hidden");
  assert.equal(await ui.locator("tbody input[type=checkbox]").count(), 0);
  assert.equal(manualCalls(), callsBefore, "cancel must not register a model");
  await addButton.click();
  assert.equal(
    await manual
      .getByRole("textbox", { name: "实际请求模型", exact: true })
      .inputValue(),
    "",
  );
  await manual
    .getByRole("textbox", { name: "菜单显示名称", exact: true })
    .fill("Hidden Code");
  await manual
    .getByRole("textbox", { name: "实际请求模型", exact: true })
    .fill("Hidden-Coding");
  await manual
    .getByRole("textbox", { name: "上下文窗口", exact: true })
    .fill("1e6");
  await manual
    .getByRole("button", { name: "添加模型草稿", exact: true })
    .click();
  await expectVisible(manual.getByRole("alert"));
  assert.equal(
    manualCalls(),
    callsBefore,
    "invalid capacity must not register a model",
  );
  await manual
    .getByRole("textbox", { name: "上下文窗口", exact: true })
    .fill("1M");
  await manual.getByRole("checkbox", { name: "low", exact: true }).check();
  await manual.getByRole("checkbox", { name: "high", exact: true }).check();
  await manual
    .getByRole("combobox", { name: "默认思考等级", exact: true })
    .selectOption("high");
  await manual
    .getByRole("combobox", { name: "图片输入", exact: true })
    .selectOption("false");
  await page.setViewportSize({ width: 390, height: 950 });
  assert(await manual.evaluate((el: any) => el.scrollWidth <= el.clientWidth));
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-manual.png"),
  });
  await manual
    .getByRole("button", { name: "添加模型草稿", exact: true })
    .click();
  await manual.waitFor({ state: "hidden" });
  assert.equal(manualCalls(), callsBefore + 1);
  await page.setViewportSize({ width: 1280, height: 1040 });
  await search.fill("Hidden-Coding");
  await expectVisible(
    ui.getByRole("checkbox", { name: "选择 Hidden Code", exact: true }),
  );
  assert.equal(
    await ui
      .getByRole("checkbox", { name: "选择 Hidden Code", exact: true })
      .isChecked(),
    true,
  );
  // Duplicate add is rejected in-place and cannot silently overwrite configured parameters.
  await addButton.click();
  await manual
    .getByRole("textbox", { name: "菜单显示名称", exact: true })
    .fill("Must not replace");
  await manual
    .getByRole("textbox", { name: "实际请求模型", exact: true })
    .fill("Hidden-Coding");
  await manual
    .getByRole("textbox", { name: "上下文窗口", exact: true })
    .fill("64K");
  await manual
    .getByRole("button", { name: "添加模型草稿", exact: true })
    .click();
  await expectVisible(
    manual.getByText(
      "此模型已在列表中，请使用该行的设置图标编辑，或填写不同的实际请求模型。",
      { exact: true },
    ),
  );
  assert.equal(
    manualCalls(),
    callsBefore + 1,
    "duplicate must not register or replace",
  );
  await closeDialog();
  await search.fill("Hidden-Coding");
  assert.equal(await ui.locator("tbody input[type=checkbox]").count(), 1);
  await ui.getByRole("button", { name: "刷新供应商模型", exact: true }).click();
  await expectVisible(ui.getByText("模型列表接口正常", { exact: true }));
  await assertHeaders();
  await expectVisible(ui.getByText("1.00M", { exact: true }));
  await expectVisible(ui.getByText("手动添加 · 本地未配置", { exact: true }));
  await search.fill("");
  await ui.getByRole("button", { name: "下一页", exact: true }).click();
  await expectVisible(ui.getByText("手动添加 · 本地未配置", { exact: true }));
  await search.fill("Hidden-Coding");
  assert.equal(f.records.filter((r) => r.method === "POST").length, 65);
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  const finalModels = JSON.parse(
    await preview.getByRole("textbox", { name: "模型目录 JSON" }).inputValue(),
  ).models;
  assert.equal(
    finalModels.find((m: any) => m.slug === "Hidden-Coding").context_window,
    1000000,
  );
  const hidden = finalModels.find((m: any) => m.slug === "Hidden-Coding");
  assert.equal(hidden.display_name, "Hidden Code");
  assert.deepEqual(
    hidden.supported_reasoning_levels.map((r: any) => r.effort),
    ["low", "high"],
  );
  assert.equal(hidden.default_reasoning_level, "high");
  assert.deepEqual(hidden.input_modalities, ["text"]);
  await closeDialog();
  assert.deepEqual(
    finalModels.slice(0, -1).map((m: any) => m.slug),
    bulkModels.map((m: any) => m.slug),
    "confirmed order survives GET and manual additions",
  );
  assert.equal(
    finalModels.at(-1).slug,
    "Hidden-Coding",
    "new selection appends to confirmed order",
  );
  assert.deepEqual(
    finalModels.map((m: any) => m.priority),
    finalModels.map((_: any, i: number) => i),
  );
  const requestsBeforeReload = f.records.length;
  await ui.getByRole("button", { name: "重新读取配置", exact: true }).click();
  await expectVisible(
    ui.getByText("已重新读取配置；内存草稿已重置。", {
      exact: true,
    }),
  );
  await assertHeaders();
  assert.equal(f.records.length, requestsBeforeReload);
  await previewButton.click();
  await expectVisible(orderDialog);
  assert.deepEqual(
    await orderDialog.locator("li .model-id").allTextContents(),
    ["Fixture-Pass", "Local-Missing"],
    "reload resets ordering to local catalog order",
  );
  await closeDialog();

  // Exercise the actual backend failure, not a synthetic UI-only error response.
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  const fixtureLock = `${f.catalogPath}.codex-model-kit.lock`;
  await writeFile(fixtureLock, "fixture lock");
  try {
    await preview
      .getByRole("button", { name: "确认写入", exact: true })
      .click();
    await expectVisible(
      preview.getByText("目录正在被其他写入操作使用。", { exact: true }),
    );
    await preview.getByText("诊断信息", { exact: true }).click();
    const diagnosticText = preview.getByRole("textbox", {
      name: "脱敏诊断信息",
      exact: true,
    });
    const reportText = await diagnosticText.inputValue();
    const report = diagnosticSchema.parse(JSON.parse(reportText));
    assert.equal(report.failure?.systemCode, "EEXIST");
    assert.equal(report.failure?.stage, "lock");
    assert(!reportText.includes(f.home));
    assert(!reportText.includes(fixtureSecret));
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await preview
      .getByRole("button", { name: "复制诊断信息", exact: true })
      .click();
    await expectVisible(preview.getByText("诊断信息已复制。", { exact: true }));
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      reportText,
    );
    // Some native hosts forbid clipboard-write; selection must remain a usable fallback.
    await diagnosticText.evaluate(() =>
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: Promise.reject.bind(
          Promise,
          new Error("fixture clipboard denied"),
        ),
      }),
    );
    await preview
      .getByRole("button", { name: "复制诊断信息", exact: true })
      .click();
    await expectVisible(
      preview.getByText("自动复制不可用，诊断信息已选中。", { exact: true }),
    );
    assert(
      await diagnosticText.evaluate(
        (el: HTMLTextAreaElement) =>
          el.selectionEnd === el.value.length && el.selectionStart === 0,
      ),
    );
    await diagnosticText.evaluate(() => {
      delete (navigator.clipboard as unknown as Record<string, unknown>)
        .writeText;
    });
    await page.screenshot({
      path: resolve(".test-artifacts/diagnostic-desktop.png"),
    });
    await page.setViewportSize({ width: 360, height: 950 });
    assert(
      await preview.evaluate(
        (el: HTMLElement) => el.scrollWidth <= el.clientWidth,
      ),
    );
    assert(
      await diagnosticText.evaluate(
        (el: HTMLElement) => el.getBoundingClientRect().right <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(".test-artifacts/diagnostic-360.png"),
    });
    await page.setViewportSize({ width: 1280, height: 1040 });
    await preview
      .getByRole("button", { name: "全选 JSON", exact: true })
      .click();
    assert(
      await preview
        .getByRole("textbox", { name: "模型目录 JSON", exact: true })
        .evaluate(
          (el: HTMLTextAreaElement) =>
            el.selectionStart === 0 && el.selectionEnd === el.value.length,
        ),
    );
    assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
  } finally {
    await unlink(fixtureLock);
    await closeDialog();
  }

  const commits = () =>
    f.toolRecords.filter((r: any) => r?.name === "commit_catalog_write").length;
  const beforeCommits = commits();
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
  await closeDialog();
  assert.equal(commits(), beforeCommits, "cancelling preview cannot write");
  await previewButton.click();
  await confirmOrder();
  await expectVisible(preview);
  assert.match(await preview.innerText(), /目标：.*models\.json/);
  const confirmedJson = await preview
    .getByRole("textbox", { name: "模型目录 JSON" })
    .inputValue();
  await preview.getByRole("button", { name: "确认写入", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  assert.equal(commits(), beforeCommits + 1);
  assert.equal(await readFile(f.catalogPath, "utf8"), confirmedJson);
  await expectVisible(
    ui
      .locator(".toast")
      .getByText(
        /^模型列表已更新，已写入 \d+ 个模型。请重启 Codex 客户端后生效。$/,
      ),
  );
  assert.equal(await ui.getByText(/上次写入已完成/).count(), 0);
  await ui.getByRole("button", { name: "写入记录与恢复", exact: true }).click();
  const history = ui.getByRole("dialog", {
    name: "写入记录与恢复",
    exact: true,
  });
  const backup = history.locator(".write-record dd:last-child code");
  await expectVisible(backup);
  assert.equal(await readFile(await backup.innerText(), "utf8"), f.catalog);
  const durabilityNotice = history.getByText(/文件已同步并回读校验/);
  assert.equal(await durabilityNotice.count(), fileSyncOnly ? 1 : 0);
  assert.equal(await history.getByText(/目录状态不确定/).count(), 0);
  assert.equal(
    await history
      .getByRole("button", { name: "恢复上次写入", exact: true })
      .isEnabled(),
    true,
  );
  if (fileSyncOnly) {
    await page.screenshot({
      path: resolve(".test-artifacts/file-sync-history-desktop.png"),
    });
    await page.setViewportSize({ width: 360, height: 950 });
    assert(
      await durabilityNotice.evaluate(
        (el: HTMLElement) => el.scrollWidth <= el.clientWidth,
      ),
    );
    await page.screenshot({
      path: resolve(".test-artifacts/file-sync-history-360.png"),
    });
    await page.setViewportSize({ width: 1280, height: 1040 });
  }
  await ui.getByRole("button", { name: "恢复上次写入" }).click();
  const restore = ui.getByRole("dialog", { name: "确认恢复目录" });
  await expectVisible(restore);
  assert.equal(await readFile(f.catalogPath, "utf8"), confirmedJson);
  await restore.getByRole("button", { name: "确认恢复" }).click();
  await restore.waitFor({ state: "hidden" });
  assert.equal(commits(), beforeCommits + 2);
  assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
  await expectVisible(
    ui
      .locator(".toast")
      .getByText("模型目录已恢复。请重启 Codex 客户端后生效。", {
        exact: true,
      }),
  );

  // Preview is optional. Reordering after preview must discard the stale plan.
  const beforeDirect = commits();
  const beforeDirectPrepare = previewCalls();
  await previewButton.click();
  assert.equal(await orderDialog.locator("textarea").count(), 0);
  await orderDialog
    .getByRole("button", { name: "置顶 Local Missing", exact: true })
    .click();
  await orderDialog
    .getByRole("button", { name: "确认写入", exact: true })
    .click();
  await orderDialog.waitFor({ state: "hidden" });
  assert.equal(commits(), beforeDirect + 1);
  assert.equal(previewCalls(), beforeDirectPrepare + 1);
  assert.deepEqual(
    JSON.parse(await readFile(f.catalogPath, "utf8")).models.map(
      (m: any) => m.slug,
    ),
    ["Local-Missing", "Fixture-Pass"],
  );
  await expectVisible(ui.locator(".toast"));
  await expectVisible(
    ui
      .locator(".toast")
      .getByText(
        /^模型列表已更新，已写入 \d+ 个模型。请重启 Codex 客户端后生效。$/,
      ),
  );
  await page.screenshot({
    path: resolve(".test-artifacts/order-ui-write-toast.png"),
  });
  await page.setViewportSize({ width: 360, height: 950 });
  assert(
    await ui.locator(".toast").evaluate((el: any) => {
      const bounds = el.getBoundingClientRect();
      return (
        el.scrollWidth <= el.clientWidth &&
        bounds.left >= 0 &&
        bounds.right <= window.innerWidth
      );
    }),
    "restart reminder toast fits the narrow viewport",
  );
  await page.screenshot({
    path: resolve(".test-artifacts/catalog-restart-toast-360.png"),
  });
  await page.setViewportSize({ width: 1280, height: 1040 });
  await ui.getByRole("button", { name: "关闭提示", exact: true }).click();
  assert.equal(await ui.locator(".toast").count(), 0);
  await ui.getByRole("button", { name: "写入记录与恢复", exact: true }).click();
  await history
    .getByRole("button", { name: "恢复上次写入", exact: true })
    .click();
  await restore.getByRole("button", { name: "确认恢复", exact: true }).click();
  await restore.waitFor({ state: "hidden" });
  assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);

  await previewButton.click();
  await confirmOrder();
  const stalePreview = await preview
    .getByRole("textbox", { name: "模型目录 JSON" })
    .inputValue();
  await preview
    .getByRole("button", { name: "返回调整顺序", exact: true })
    .click();
  await expectVisible(orderDialog);
  await orderDialog
    .getByRole("button", { name: "置底 Local Missing", exact: true })
    .click();
  assert.equal(await orderDialog.locator("textarea").count(), 0);
  await orderDialog
    .getByRole("button", { name: "确认写入", exact: true })
    .click();
  await orderDialog.waitFor({ state: "hidden" });
  assert.notEqual(await readFile(f.catalogPath, "utf8"), stalePreview);
  assert.deepEqual(
    JSON.parse(await readFile(f.catalogPath, "utf8")).models.map(
      (m: any) => m.slug,
    ),
    ["Fixture-Pass", "Local-Missing"],
  );
  await ui.getByRole("button", { name: "写入记录与恢复", exact: true }).click();
  await history
    .getByRole("button", { name: "恢复上次写入", exact: true })
    .click();
  await restore.getByRole("button", { name: "确认恢复", exact: true }).click();
  await restore.waitFor({ state: "hidden" });
  assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
  assert.equal(
    await readFile(resolve(f.home, "config.toml"), "utf8"),
    f.config,
  );

  await ui
    .getByText("配置指引 / 选择其他已配置的 provider", { exact: true })
    .click();
  await provider.selectOption(
    await provider.locator("option").nth(1).getAttribute("value"),
  );
  await ui.getByRole("checkbox", { name: /如使用 HTTP/ }).check();
  await ui.getByRole("button", { name: "使用已有配置", exact: true }).click();
  await expectVisible(ui.getByText("配置完整 · 网络待检查", { exact: true }));

  modelsStatus = 503;
  await ui.getByRole("button", { name: "刷新供应商模型", exact: true }).click();
  await expectVisible(
    ui.locator(".toast-error").getByText(/^刷新供应商模型失败：/),
  );
  assert(!(await ui.locator(".toast").innerText()).includes(fixtureSecret));
  assert(!(await ui.locator(".toast").innerText()).includes("✓"));
  await page.screenshot({
    path: resolve(".test-artifacts/refresh-error-toast.png"),
  });
  modelsStatus = 200;
  await ui.getByRole("button", { name: "刷新供应商模型", exact: true }).click();
  await expectVisible(
    ui.locator(".toast:not(.toast-error)").getByText(/^供应商模型已刷新/),
  );
  await ui.locator(".toast").waitFor({ state: "hidden", timeout: 7000 });
  assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);

  const fixtureConfig = resolve(f.home, "config.toml");
  await writeFile(fixtureConfig, `bad = "${fixtureSecret}\n`);
  try {
    await ui.getByRole("button", { name: "重新读取配置", exact: true }).click();
    await expectVisible(
      ui
        .locator(".toast-error")
        .getByText("配置或模型目录读取失败。", { exact: true }),
    );
    const readFailure = ui.locator(".live-message");
    await readFailure.getByText("诊断信息", { exact: true }).click();
    const reportText = await readFailure
      .getByRole("textbox", { name: "脱敏诊断信息", exact: true })
      .inputValue();
    const report = diagnosticSchema.parse(JSON.parse(reportText));
    assert.equal(report.failure?.rule, "invalid_toml");
    assert.equal(report.operation, "load_sync");
    assert(!reportText.includes(fixtureSecret));
    assert(!reportText.includes(f.home));
  } finally {
    await writeFile(fixtureConfig, f.config);
  }
  await ui.getByRole("button", { name: "重新读取配置", exact: true }).click();
  await expectVisible(
    ui.getByText("已重新读取配置；内存草稿已重置。", { exact: true }),
  );
  assert.equal(await ui.locator(".live-message .diagnostic").count(), 0);

  assert.equal(pageErrors.length, 0);
  assert.equal(audit.length, 0);
  assert(!JSON.stringify(f.toolRecords).includes(fixtureSecret));
  await writeFile(
    envAuth
      ? ".test-artifacts/env-ui-qa.json"
      : fileSyncOnly
        ? ".test-artifacts/file-sync-ui-qa.json"
        : ".test-artifacts/order-ui-qa.json",
    JSON.stringify(
      {
        version: VERSION,
        status: "passed",
        credentialMode: envAuth ? "env" : "bearer",
        fileSyncOnly,
        scope:
          "isolated SDK AppBridge + bundled STDIO + fake relay, NOT native Codex UI or real relay",
        viewports: [
          "1280x1040",
          "900x950",
          "650x950",
          "430x950",
          "390x950",
          "360x950",
        ],
        scrollbarAudit,
        themes: ["light", "dark"],
        requests: f.records,
        assertions: [
          "actual lock failure exposes bounded diagnostic and copies the exact report; denied clipboard selects the report; long preview paths fit 360px; select-all still targets model JSON; config parse failure has a safe diagnostic/error toast and clears after recovery",
          "ordering explains restart after catalog JSON write across six widths; preview/direct write and restore success toasts remind restart; narrow toast fits viewport",
          "refresh toast awaits async completion, reports provider count, dismisses, auto-hides, and safely reports failure/recovery",
          "auto read-only discovery, no implicit inference",
          "local selection and supplier membership",
          "local capability priority",
          "HTML escape",
          "prototype-like model IDs remain selectable",
          "pagination preserves local selection",
          "parameter edits survive poll/GET",
          "JSON preserves custom fields/instructions",
          "JSON modal focus/Escape",
          "ordering up/down/top/bottom, cancellation without preview calls, remembered confirmed order and JSON priorities; narrow dialog",
          "separate optional preview dialog; return/close/Escape preserve ordering and focus; direct write, stale preview invalidation, refresh/write/restore toast and separate records entry",
          "preview footer keeps select-all JSON, return and write on one row without overlap at six widths; select-all focuses and selects the complete JSON",
          "stable visible capability/settings headers before refresh, after reload and across widths",
          "probe confirmation SVG close and token consumption wording",
          "confirmation cancellation no POST",
          "all 70 rows selected across pages with one checkbox-free confirmation",
          "61-model serial batch after one confirmation, no duplicate batch requests",
          "preview disabled reason visible",
          "relative catalog read against CODEX_HOME",
          "modal parameter editor",
          "initial and repeated tests visibly mask old results with testing state",
          "success summary not duplicated in rows; failed/unknown details open on click",
          "seven known rows preview; unknown seventh opens actionable modal; 61 rows preview",
          "update validates before ordering; unknown context/images and image-only errors block ordering and prepare/commit with unchanged catalog; corrected drafts enter ordering/preview; six-width single-row name/reason/edit icons; no obsolete footer; close icon restores focus",
          "all opened dialogs share an accessible SVG close button with hover title and no visible text",
          "fixed K/M context increments, validated text input, ascending wrapping efforts",
          "help modal focus restore; no fullscreen controls; server-masked fingerprint only",
          "container-responsive capability column; no narrow table/editor overflow",
          "shared full manual/edit parameter form; validation/cancel no registration; duplicate rejected without replacement; all parameters survive GET/JSON",
          "table edge padding and no horizontal overflow with real 12/18/24px vertical scrollbars across six widths",
          "header title font sizes swapped",
          "editor has accessible close icon",
          "no duplicate row",
          "only-selected filter",
          "narrow no body overflow",
          "config/catalog/auth bytes unchanged (fixture close)",
          "no secrets in tools",
          "no external browser requests",
        ],
        screenshots: [
          "catalog-restart-toast-360.png",
          "preview-footer-360.png",
          "refresh-toast.png",
          "refresh-error-toast.png",
          "order-ui-desktop.png",
          "order-ui-editor.png",
          "order-ui-preview.png",
          "order-ui-dark.png",
          "order-ui-narrow.png",
          "order-ui-narrow-preview.png",
          "order-ui-preview-problem.png",
          "validation-problem-360.png",
          "order-ui-test-details.png",
          "order-ui-many-preview.png",
          "order-ui-help.png",
          "order-ui-narrow-editor.png",
          "order-ui-manual.png",
          "order-ui-scrollbar.png",
          "order-ui-sort.png",
          "order-ui-confirm.png",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Sync UI QA passed: real SDK + bundled STDIO; all configuration/catalog bytes unchanged.",
  );
} finally {
  await browser?.close();
  await f.close();
}
