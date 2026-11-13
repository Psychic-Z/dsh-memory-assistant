window.__ModuleLoader__.load({
  id: "@local/dsh-memory-assistant",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react;
    try {
      react = require("react");
    } catch (e) {
      react = null;
    }

    const BASE = "/memory-assistant/api";

    // 把「空响应/非 JSON」翻成人话：接口没注册时回的是 404 空包，
    // 直接 r.json() 只会报 "Unexpected end of JSON input"，看不出是哪种坏。
    const getJson = (url, init) =>
      fetch(url, init).then(async (r) => {
        const text = await r.text();
        if (!r.ok) {
          throw new Error(
            "HTTP " + r.status + (text ? "：" + text.slice(0, 120) : "（空响应——多半是接口没注册）"),
          );
        }
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error("返回不是 JSON：" + text.slice(0, 80));
        }
      });

    /* ────────────────────────────────────────────────────────────────────
     * 样式：全部走宿主主题 token（--dsw-alias-*），这样亮/暗主题都跟得上。
     * 之前的版本把 token 名写错成了 --dsw-alias-border-1 / --dsw-alias-text-2 /
     * --dsw-alias-brand-1，浏览器解析失败就吃后面的硬编码浅色兜底 —— 暗色主题下
     * 面板是白底黑字，看着像没做样式。这里按 Theme 服务的真实 token 名重写。
     * ──────────────────────────────────────────────────────────────────── */
    const CSS = `
.ma-wrap{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);padding:2px 2px 18px}
.ma-head{display:flex;align-items:baseline;gap:8px;margin:2px 0 2px}
.ma-title{font-size:15px;font-weight:600;letter-spacing:.2px}
.ma-ver{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ma-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 14px}
.ma-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;margin-bottom:12px}
.ma-card--accent{border-color:var(--dsw-alias-brand-primary)}
.ma-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.ma-card-title{font-weight:600;font-size:13px}
.ma-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.ma-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ma-row+.ma-row,.ma-row+.ma-hint,.ma-hint+.ma-row{margin-top:9px}
.ma-label{min-width:88px;color:var(--dsw-alias-label-secondary);font-size:12px;flex:0 0 auto}
.ma-input{flex:1 1 160px;min-width:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;outline:none;transition:border-color .15s}
.ma-input:focus{border-color:var(--dsw-alias-brand-primary)}
.ma-btn{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:border-color .15s,background .15s,opacity .15s;white-space:nowrap}
.ma-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.ma-btn:disabled{opacity:.45;cursor:not-allowed}
.ma-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.ma-btn--primary:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);filter:brightness(1.08)}
.ma-btn--ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ma-btn--ghost:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ma-radios{display:flex;flex-wrap:wrap;gap:7px 16px;flex:1 1 200px}
.ma-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ma-radio input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.ma-choices{display:flex;flex-direction:column;gap:9px;margin-top:6px}
.ma-choice{display:flex;flex-direction:column;gap:2px;cursor:pointer}
.ma-choice .ma-radio{color:var(--dsw-alias-label-primary)}
.ma-choice-tip{color:var(--dsw-alias-label-secondary);font-size:11px;padding-left:20px}
.ma-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:2px 0 12px}
.ma-stat{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}
.ma-stat-num{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.25}
.ma-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.ma-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ma-chip--ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.ma-chip--warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.ma-chip--err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.ma-bar{height:6px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;margin:10px 0}
.ma-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}
.ma-msg{font-size:12px;padding:8px 10px;border-radius:8px;border-left:3px solid currentColor;background:transparent;margin-top:10px;color:var(--dsw-alias-label-primary)}
.ma-msg--ok{color:var(--dsw-alias-label-primary);border-left-color:var(--dsw-alias-state-success-primary)}
.ma-msg--err{color:var(--dsw-alias-label-primary);border-left-color:var(--dsw-alias-state-error-primary)}
.ma-div{height:1px;background:var(--dsw-alias-border-l1);margin:12px 0}
.ma-list{display:flex;flex-direction:column;gap:2px;margin-top:8px}
.ma-item{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ma-item b{color:var(--dsw-alias-label-primary);font-weight:500}
`;

    function Panel() {
      const [cfg, setCfg] = react.useState(null);
      const [stats, setStats] = react.useState(null);
      const [msg, setMsg] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [imp, setImp] = react.useState(null);
      const [tool, setTool] = react.useState(null);
      const [usage, setUsage] = react.useState(null);
      const [impBusy, setImpBusy] = react.useState(false);
      const [audit, setAudit] = react.useState(null);
      const [auditBusy, setAuditBusy] = react.useState(false);
      const [undo, setUndo] = react.useState(null);
      const [backups, setBackups] = react.useState(null);
      const [restoreBusy, setRestoreBusy] = react.useState(false);
      const [auto, setAuto] = react.useState(null);

      const load = () => {
        getJson(BASE + "/state")
          .then((d) => {
            setCfg(d.config || {});
            setStats(d.stats || null);
            setImp(d.import || null);
            setTool(d.tools || null);
            setUsage(d.usage || null);
            setAuto(d.auto || null);
          })
          .catch((e) => setMsg("读取失败：" + e.message));
      };

      react.useEffect(() => {
        load();
      }, []);

      // 导入在后台跑：只要状态是 running，就每 2 秒拉一次进度
      const running = !!(imp && imp.run && (imp.run.status === "running" || (imp.run.codes && imp.run.codes.status === "running")));
      react.useEffect(() => {
        if (!running) return undefined;
        const t = setInterval(load, 2000);
        return () => clearInterval(t);
      }, [running]);

      const post = (path, body) =>
        getJson(BASE + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });

      const startImport = (scope) => {
        setImpBusy(true);
        setMsg("");
        post("/import/start", { scope })
          .then((d) => setImp(d.import || null))
          .catch((e) => setMsg("没能开始整理：" + e.message))
          .finally(() => setImpBusy(false));
      };
      const cancelImport = () => {
        setImpBusy(true);
        post("/import/cancel")
          .then((d) => setImp(d.import || null))
          .catch((e) => setMsg("取消失败：" + e.message))
          .finally(() => setImpBusy(false));
      };
      const resumeImport = () => {
        setImpBusy(true);
        post("/import/resume")
          .then((d) => setImp(d.import || null))
          .catch((e) => setMsg("继续整理失败：" + e.message))
          .finally(() => setImpBusy(false));
      };
      const dismissOnboarding = () => {
        setImpBusy(true);
        post("/import/dismiss")
          .then((d) => setImp(d.import || null))
          .catch((e) => setMsg("操作失败：" + e.message))
          .finally(() => setImpBusy(false));
      };
      const buildCodes = () => {
        setImpBusy(true);
        setMsg("正在创建关键词…");
        post("/import/codes")
          .then(() => {
            setMsg("");
            setTimeout(load, 3000);
          })
          .catch((e) => setMsg("创建关键词失败：" + e.message))
          .finally(() => setImpBusy(false));
      };

      // 别名体检：先看（只读），确认了才删（后端会自动备份 + 版本 +1）
      const runAudit = () => {
        setAuditBusy(true);
        setMsg("");
        getJson(BASE + "/concepts/audit?tier=" + ((cfg && cfg.aliasTier) || "B"))
          .then((d) => setAudit(d))
          .catch((e) => setMsg("检查失败：" + e.message))
          .finally(() => setAuditBusy(false));
      };
      const applyAudit = () => {
        setAuditBusy(true);
        post("/concepts/prune", { tier: (cfg && cfg.aliasTier) || "B" })
          .then((d) => {
            const undoV = d.undoVersion || d.version;
            setAudit(null);
            setUndo({ version: undoV, removed: d.removed });
            setMsg("已清理 " + d.removed + " 个关键词，删除前的版本已备份，可随时恢复");
            load();
          })
          .catch((e) => setMsg("清理失败：" + e.message))
          .finally(() => setAuditBusy(false));
      };
      // 删坏了：恢复到清理前的版本（恢复前也会把当前版本备份一份）
      const undoAudit = () => {
        if (!undo) return;
        setAuditBusy(true);
        post("/concepts/restore", { version: undo.version })
          .then((d) => {
            setMsg("已恢复：关键词 " + d.concepts + " 个（当前版本 v" + d.version + "）");
            setUndo(null);
            load();
          })
          .catch((e) => setMsg("恢复失败：" + e.message))
          .finally(() => setAuditBusy(false));
      };
      // 口径单选：换口径要把上一次的体检结果作废，否则「清理 N 个」还是旧口径的数字
      const pickTier = (t) => {
        setCfg(Object.assign({}, cfg || {}, { aliasTier: t }));
        setAudit(null);
      };
      const TIER_NAME = { A: "最保守", B: "推荐", C: "激进" };
      const tierRadio = (value, label, tip) => {
        const cur = (cfg && cfg.aliasTier) || "B";
        const n = audit && audit.counts ? audit.counts[value] : null;
        return el(
          "label",
          { className: "ma-choice" },
          el(
            "span",
            { className: "ma-radio" },
            el("input", { type: "radio", name: "aliasTier", checked: cur === value, onChange: () => pickTier(value) }),
            label + (n === null || n === undefined ? "" : "（" + n + " 个）"),
          ),
          tip ? el("span", { className: "ma-choice-tip" }, tip) : null,
        );
      };

      // 历史版本：刷新页面后也能恢复（撤销按钮只在刚清理完那一次有效）
      const loadBackups = () => {
        setRestoreBusy(true);
        setMsg("");
        getJson(BASE + "/concepts/backups")
          .then((d) => setBackups(d.backups || []))
          .catch((e) => setMsg("读不到历史版本：" + e.message))
          .finally(() => setRestoreBusy(false));
      };
      const doRestore = (v) => {
        setRestoreBusy(true);
        post("/concepts/restore", { version: v })
          .then((d) => {
            setMsg("已恢复到 v" + v + "：关键词 " + d.concepts + " 个（当前版本 v" + d.version + "）");
            setBackups(null);
            setUndo(null);
            setAudit(null);
            load();
          })
          .catch((e) => setMsg("恢复失败：" + e.message))
          .finally(() => setRestoreBusy(false));
      };
      const save = () => {
        setBusy(true);
        getJson(BASE + "/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cfg || {}),
        })
          .then((d) => {
            setMsg(d.ok ? "已保存" : "保存失败：" + (d.error || ""));
            if (d.ok) load();
          })
          .catch((e) => setMsg("保存失败：" + e.message))
          .finally(() => setBusy(false));
      };

      const set = (k) => (ev) => setCfg(Object.assign({}, cfg || {}, { [k]: ev.target.value }));

      const radio = (name, value, label) => {
        const raw = cfg ? cfg[name] : undefined;
        const current =
          name === "recentCards"
            ? raw === undefined || raw === "" ? 50 : raw
            : name === "proactive" || name === "autoImport"
              ? raw === undefined ? true : raw
              : raw === undefined ? "" : raw;
        return el(
          "label",
          { className: "ma-radio" },
          el("input", {
            type: "radio",
            name,
            checked: String(current) === String(value),
            onChange: () => setCfg(Object.assign({}, cfg || {}, { [name]: value })),
          }),
          label,
        );
      };

      const el = react.createElement;
      const btn = (kind, extra) =>
        "ma-btn" + (kind === "primary" ? " ma-btn--primary" : kind === "ghost" ? " ma-btn--ghost" : "") + (extra ? " " + extra : "");
      const chip = (kind, text) => el("span", { className: "ma-chip" + (kind ? " ma-chip--" + kind : "") }, text);

      const importBlock = (() => {
        if (!imp) return null;
        const r = imp.run;
        const active = r && (r.status === "running" || r.status === "paused" || r.status === "failed");
        if (active) {
          const pct = r.batches ? Math.round((r.done / r.batches) * 100) : 0;
          return el(
            "div",
            { className: "ma-card ma-card--accent" },
            el(
              "div",
              { className: "ma-card-head" },
              el("span", { className: "ma-card-title" }, r.status === "running" ? "正在整理对话…" : r.status === "paused" ? "整理已暂停" : "整理中断"),
              chip(r.status === "failed" ? "err" : "warn", r.status === "running" ? pct + "%" : r.status === "paused" ? "暂停" : "中断"),
            ),
            el("div", { className: "ma-bar" }, el("i", { style: { width: pct + "%" } })),
            el("div", { className: "ma-hint" }, "已完成 " + r.done + "/" + r.batches + " 段 · 本次新增 " + r.cardsAdded + " 张 · 共 " + imp.cards + " 张记忆卡片"),
            r.error ? el("div", { className: "ma-msg ma-msg--err" }, r.error) : null,
            el(
              "div",
              { className: "ma-row", style: { marginTop: "10px" } },
              r.status === "running"
                ? el("button", { className: btn(), disabled: impBusy, onClick: cancelImport }, "暂停")
                : el("button", { className: btn("primary"), disabled: impBusy, onClick: resumeImport }, "继续"),
              el("span", { className: "ma-hint" }, "每整理完一段就保存，暂停或关掉窗口都不会丢进度"),
            ),
          );
        }
        if (!imp.imported) {
          const cur = tool && tool.preview;
          const all = tool && tool.all;
          const est = all ? Math.max(1, Math.round((all.sessions || 0) * 4.5)) : 0;
          return el(
            "div",
            { className: "ma-card ma-card--accent" },
            el(
              "div",
              { className: "ma-card-head" },
              el("span", { className: "ma-card-title" }, "第一步：把过去的对话整理成记忆卡片"),
              chip("warn", "未整理"),
            ),
            el("div", { className: "ma-hint" }, "读取本机保存的历史对话，整理成记忆卡片存在本地。只读，不会改动原来的对话；可以暂停，断了能接着来。"),
            cur || all
              ? el(
                  "div",
                  { className: "ma-list" },
                  cur ? el("div", { className: "ma-item" }, "当前对话：", el("b", null, "这一场")) : null,
                  all
                    ? el(
                        "div",
                        { className: "ma-item" },
                        "全部对话：",
                        el("b", null, String(all.sessions)),
                        " 场主对话 · 约 ",
                        el("b", null, String(est)),
                        " 段 · 自动跳过 ",
                        el("b", null, String(all.subagentSessions)),
                        " 场子助手",
                      )
                    : null,
                  ...(((all && all.workspaces) || []).map((w) =>
                    el("div", { className: "ma-item" }, "· " + w.project + "：" + w.sessions + " 场"),
                  )),
                )
              : null,
            el(
              "div",
              { className: "ma-row", style: { marginTop: "12px" } },
              el("button", { className: btn("primary"), disabled: impBusy, onClick: () => startImport("current") }, "只整理当前对话"),
              el("button", { className: btn(), disabled: impBusy, onClick: () => startImport("all") }, "整理全部对话"),
              el("button", { className: btn("ghost"), disabled: impBusy, onClick: dismissOnboarding }, "稍后再说"),
            ),
            el("div", { className: "ma-hint", style: { marginTop: "8px" } }, "整理需要调用模型：当前对话几段，全部几十段，按实际用量计费。"),
          );
        }

        // 已导入：一块数据条 + 一段操作
        const codes = imp.codes;
        const blankN = codes && codes.blank ? codes.blank : 0;
        const failedN = codes && codes.failed ? codes.failed : 0;
        return el(
          "div",
          { className: "ma-card" },
          el(
            "div",
            { className: "ma-card-head" },
            el("span", { className: "ma-card-title" }, "记忆库"),
            el(
              "span",
              { className: "ma-row", style: { gap: "6px" } },
              chip("ok", "已就绪"),
              chip(blankN ? "warn" : "ok", "关键词 " + (codes ? codes.coded + "/" + codes.total : "-")),
            ),
          ),
          el(
            "div",
            { className: "ma-stats" },
            el("div", { className: "ma-stat" }, el("div", { className: "ma-stat-num" }, String(imp.cards)), el("div", { className: "ma-stat-label" }, "记忆卡片")),
            el("div", { className: "ma-stat" }, el("div", { className: "ma-stat-num" }, String(codes ? codes.concepts : "-")), el("div", { className: "ma-stat-label" }, "关键词")),
            el("div", { className: "ma-stat" }, el("div", { className: "ma-stat-num" }, String((imp.sessions || []).length)), el("div", { className: "ma-stat-label" }, "来源对话")),
            el("div", { className: "ma-stat" }, el("div", { className: "ma-stat-num" }, String(blankN)), el("div", { className: "ma-stat-label" }, "无关键词")),
          ),
          el(
            "div",
            { className: "ma-list" },
            ...((tool && tool.all && tool.all.workspaces) || []).length
              ? ((tool.all.workspaces || []).map((w) => {
                  const hit = (imp.projects || []).find((x) => x.project === w.project);
                  return el(
                    "div",
                    { className: "ma-item" },
                    w.project + " — " + (hit ? hit.cards + " 张（" + w.sessions + " 场）" + (hit.latest ? " · 最近 " + hit.latest : "") : "未整理（" + w.sessions + " 场）"),
                  );
                }))
              : (imp.projects || []).map((p) => el("div", { className: "ma-item" }, p.project + " — " + p.cards + " 张")),
            el(
              "div",
              { className: "ma-item" },
              "来源对话 " + (imp.sessions || []).length + " 场：" +
                (imp.sessions || []).slice(0, 3).map((s) => (s.title || s.session.slice(0, 8)) + "（" + s.cards + "）").join("、"),
            ),
            failedN
              ? el("div", { className: "ma-item", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "上次有 " + failedN + " 张没创建关键词" + (codes.lastError ? "：" + String(codes.lastError).slice(0, 60) : ""))
              : null,
            imp.run && imp.run.codes && imp.run.codes.status === "running"
              ? el("div", { className: "ma-item" }, "正在创建关键词…")
              : null,
            blankN
              ? el("div", { className: "ma-item" }, "「无关键词」= 卡片里找不到关键词表里的词，按规则留空，不影响搜索")
              : null,
          ),
          el(
            "div",
            { className: "ma-row", style: { marginTop: "12px" } },
            el("button", { className: btn("primary"), disabled: impBusy, onClick: () => startImport("incremental") }, "更新记忆（只整理新对话）"),
            codes && codes.coded < codes.total
              ? el("button", { className: btn(), disabled: impBusy, onClick: buildCodes }, codes.concepts ? "继续创建关键词" : "创建关键词")
              : null,
            el("span", { className: "ma-hint" }, "只整理上次更新之后的新对话；创建关键词会重试没有关键词的卡片"),
          ),
        );
      })();

      const behaviorCard = el(
        "div",
        { className: "ma-card" },
        el("div", { className: "ma-card-head" }, el("span", { className: "ma-card-title" }, "提醒与更新")),
        el(
          "div",
          { className: "ma-row" },
          el("span", { className: "ma-label" }, "主动提问"),
          el("div", { className: "ma-radios" }, radio("proactive", true, "开（相关时才提 1–3 条）"), radio("proactive", false, "关（只在问我时查）")),
        ),
        el(
          "div",
          { className: "ma-row" },
          el("span", { className: "ma-label" }, "记忆自动入库"),
          el("div", { className: "ma-radios" }, radio("autoImport", true, "开（≥6 轮且隔 20 分钟）"), radio("autoImport", false, "关（只手动点）")),
        ),
        el(
          "div",
          { className: "ma-hint", style: { marginTop: "8px" } },
          auto
            ? "上次自动更新 " +
                String(auto.lastRunAt || "").slice(5, 16).replace("T", " ") +
                "（" +
                ({ started: "已开始整理", "nothing-new": "没有新内容", running: "正在整理" }[auto.lastResult] ||
                  (auto.lastResult && String(auto.lastResult).indexOf("error") === 0 ? "出错：" + String(auto.lastResult).slice(7) : auto.lastResult || "-")) +
                "）· 已攒 " +
                (auto.pending || 0) +
                " 轮"
            : "还没有自动更新过。攒够 6 轮、且距上次超过 20 分钟时，会在每轮结束时自动整理一次。",
        ),
      );

      const maintCard = el(
        "div",
        { className: "ma-card" },
        el(
          "div",
          { className: "ma-card-head" },
          el("span", { className: "ma-card-title" }, "关键词维护"),
          audit ? chip(audit.candidates.length ? "warn" : "ok", "候选 " + audit.candidates.length + " 个") : null,
        ),
        el(
          "div",
          { className: "ma-row" },
          el("button", { className: btn(), disabled: auditBusy, onClick: runAudit }, "检查"),
          audit && audit.candidates.length
            ? el("button", { className: btn("primary"), disabled: auditBusy, onClick: applyAudit }, "清理 " + audit.candidates.length + " 个")
            : null,
          undo ? el("button", { className: btn(), disabled: auditBusy, onClick: undoAudit }, "撤销（恢复到 v" + undo.version + "）") : null,
        ),
        el(
          "div",
          { className: "ma-hint", style: { marginTop: "8px" } },
          audit
            ? "候选 " + audit.candidates.length + " 个（" + (TIER_NAME[audit.tier] || audit.tier) + "）" +
              (audit.candidates.length ? "：" + audit.candidates.slice(0, 5).map((x) => x.alias).join("、") + "…" : "")
            : "找出太笼统的关键词（单个字 / 多个关键词共用 / 太常见）；只检查，不修改",
        ),
        el("div", { className: "ma-label", style: { marginTop: "12px" } }, "清理范围"),
        el(
          "div",
          { className: "ma-choices" },
          tierRadio("A", "只删单个字", "最保守：一个字在卡片里几乎什么都能对上"),
          tierRadio("B", "再删多个关键词共用的词", "推荐：一个词被好几个关键词共用，等于没有区分度"),
          tierRadio("C", "再删太常见、没区分度的词", "激进：像「检索」「插件」这类到处都是的词"),
        ),
        el("div", { className: "ma-hint", style: { marginTop: "8px" } }, "删除前会自动备份，随时能恢复；关键词本身的名称不会被删。换范围后要重新点「检查」。"),
        el("div", { className: "ma-div" }),
        el(
          "div",
          { className: "ma-row" },
          el("button", { className: btn(), disabled: restoreBusy, onClick: loadBackups }, "历史版本 / 恢复"),
          el("span", { className: "ma-hint" }, backups === null ? "刷新后也能恢复：每个版本标着版本号和关键词数" : "点一个就恢复（恢复前也会把当前版本备份一份）"),
        ),
        backups && backups.length
          ? el(
              "div",
              { className: "ma-row", style: { marginTop: "8px" } },
              ...backups.slice(0, 6).map((b) =>
                el("button", { className: btn("ghost"), disabled: restoreBusy, onClick: () => doRestore(b.version) }, "v" + b.version + "（" + (b.concepts == null ? "?" : b.concepts) + "）"),
              ),
            )
          : null,
      );

      return el(
        "div",
        { className: "ma-wrap" },
        // 样式挂在面板自己身上：不管宿主把面板渲染在 document 还是 shadow root 里都吃得到
        el("style", null, CSS),
        el("div", { className: "ma-head" }, el("span", { className: "ma-title" }, "记忆助理"), el("span", { className: "ma-ver" }, "v0.1.0")),
        el("div", { className: "ma-sub" }, "将对话整理成记忆卡片，用关键词检索定位。如果没找到或者不确定，会追问。"),
        importBlock,
        el(
          "div",
          { className: "ma-card" },
          el("div", { className: "ma-card-head" }, el("span", { className: "ma-card-title" }, "搜索")),
          el(
            "div",
            { className: "ma-row" },
            el("span", { className: "ma-label" }, "记忆库位置"),
            el("input", { className: "ma-input", value: (cfg && cfg.dataDir) || "", placeholder: "默认 ~/.dsh-memory-assistant", onChange: set("dataDir") }),
          ),
          el(
            "div",
            { className: "ma-row" },
            el("span", { className: "ma-label" }, "每次返回"),
            el("input", { className: "ma-input", style: { flex: "0 0 80px" }, value: (cfg && cfg.topK) || 3, onChange: set("topK") }),
            el("span", { className: "ma-hint" }, "条"),
          ),
          el(
            "div",
            { className: "ma-row" },
            el("span", { className: "ma-label" }, "搜索范围"),
            el(
              "div",
              { className: "ma-radios" },
              radio("workspace", "", "跟随当前对话"),
              radio("workspace", "all", "全部项目"),
              ...(((tool && tool.all && tool.all.workspaces) || []).map((w) => radio("workspace", w.project, w.project))),
            ),
          ),
          el(
            "div",
            { className: "ma-row" },
            el("span", { className: "ma-label" }, "自动带上最近"),
            el("div", { className: "ma-radios" }, ...[0, 10, 20, 50, 100].map((n) => radio("recentCards", n, n === 0 ? "不带" : n + " 张"))),
          ),
        ),
        behaviorCard,
        maintCard,
        el(
          "div",
          { className: "ma-row", style: { marginTop: "4px" } },
          el("button", { className: btn("primary"), disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
          el("button", { className: btn("ghost"), onClick: load }, "刷新"),
        ),
        stats
          ? el(
              "div",
              { className: "ma-hint", style: { marginTop: "8px" } },
              "记忆卡片 " + stats.cards + " 张 · 已查询 " + stats.asks + " 次 · 需要追问 " + stats.need_confirm_rate + " · 满意率 " + stats.satisfaction,
            )
          : null,
        msg ? el("div", { className: "ma-msg " + (msg.indexOf("失败") >= 0 || msg.indexOf("没能") >= 0 ? "ma-msg--err" : "ma-msg--ok") }, msg) : null,
        usage && usage.queries
          ? el(
              "div",
              { className: "ma-hint", style: { marginTop: "10px" } },
              "搜索 " + usage.queries + " 次 · 实际消耗 " + usage.actualTokens + "（平均 " + usage.perQuery + "/次）· 若把全部卡片都带上要 " + usage.queries * usage.baselineLibrary + " · 省约 " + usage.savedVsLibrary,
            )
          : null,
        el("div", { className: "ma-hint", style: { marginTop: "8px" } }, "改完点保存，下一轮生效；第一次用，在对话里说「导入记忆」或「更新记忆」。"),
      );
    }

    function apply(ctx) {
      try {
        if (!react) return;
        const slots = ctx.slots;
        if (!slots || !slots.inject) return;
        slots.inject("settings.section", () =>
          slots.register(
            {
              name: "settings.section",
              id: "memory-assistant",
              order: 120,
              label: () => "记忆助理",
            },
            Panel,
          ),
        );
      } catch (e) {
        try {
          console.warn("[memory-assistant] client register failed", e && e.message);
        } catch (_) {}
      }

      // 若装了 better-sidebar，再往右侧边栏挂一个「记忆助理」页签
      try {
        const bs = ctx.betterSidebar;
        if (bs && typeof bs.registerTab === "function") {
          const el = react.createElement;
          bs.registerTab({
            id: "memory-assistant:settings",
            title: () => "记忆助理",
            description: () => "记忆助理的设置与统计",
            icon: (size) => el("span", { style: { fontSize: Math.max(11, (size || 16) - 4) } }, "记"),
            order: 60,
            single: true,
            component: () => el(Panel),
          });
        }
      } catch (e) {
        try {
          console.warn("[memory-assistant] sidebar tab register failed", e && e.message);
        } catch (_) {}
      }
    }

    exports.apply = apply;
    // 这里是 cordis 的「服务名」，不是包名：slots 服务由 @deepseek-ai/dsh-client-ui-slots 提供。
    // 写成包名会一直等不到服务，入口静默不激活（面板不出现）。
    exports.inject = ["slots"];
    return module.exports;
  },
});
