/* HCChart —— 交互式趋势大图（无框架、无外部依赖，全屏弹层）
 * 能力：全量数据点、时间范围切换（全部/90/30/14天）、拖动平移、双指/滚轮缩放、
 * 十字线悬浮气泡、点详情（含来源报告溯源跳转）、分段参考区间带、深色模式跟随（CSS 变量）。
 * 纯前端组件：只读 app.js 传来的内存数据，不发起任何网络请求。 */
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x) => String(parseFloat(x.toPrecision(4)));

  /* 图表配色全部走 CSS 变量，深色模式/主题切换时重渲染即可 */
  function themeColors() {
    let cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch {}
    const g = (v, fb) => {
      const val = cs ? cs.getPropertyValue(v).trim() : "";
      return val || fb;
    };
    return {
      band: g("--chart-band", "#e7f6ec"),
      bandEdge: g("--chart-band-edge", "#40c057"),
      grid: g("--chart-grid", "#edf1f7"),
      label: g("--chart-label", "#9aa8b8"),
      line: g("--chart-line", "#3e7bfa"),
      area: g("--chart-area", "rgba(62,123,250,.08)"),
      hi: g("--c-hi", "#e03131"),
      lo: g("--c-lo", "#1c7ed6"),
      text: g("--text", "#1e2a38"),
      cross: g("--chart-cross", "#c3cedd"),
    };
  }

  /* 统计条：最高/最低/均值/异常点/较上次变化（对当前筛选范围，非可视窗口） */
  function statsOf(points) {
    const vals = points.map((p) => p.v).filter((v) => Number.isFinite(v));
    if (!vals.length) return null;
    const max = Math.max.apply(null, vals);
    const min = Math.min.apply(null, vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const abn = points.filter((p) => p.flag === "↑" || p.flag === "↓").length;
    let delta = null;
    for (let i = points.length - 1; i > 0; i--) {
      if (Number.isFinite(points[i].v) && Number.isFinite(points[i - 1].v)) {
        delta = points[i].v - points[i - 1].v;
        break;
      }
    }
    return { max, min, avg, abn, delta, n: vals.length };
  }

  const RANGES = [
    ["all", "全部"],
    [90, "90天"],
    [30, "30天"],
    [14, "14天"],
  ];

  let active = null; // 当前打开的弹层状态（单例）

  function close() {
    if (!active) return;
    const st = active;
    active = null;
    try {
      if (st.mq && st.mqHandler) {
        if (st.mq.removeEventListener) st.mq.removeEventListener("change", st.mqHandler);
        else if (st.mq.removeListener) st.mq.removeListener(st.mqHandler);
      }
      document.removeEventListener("keydown", st.onKey);
      st.el.remove();
      document.body.style.overflow = st.prevOverflow || "";
    } catch {}
  }

  /**
   * opts: {
   *   title: string, tag?: string, points: [{v,flag,t,day,date,tm,ref_lo,ref_hi,ref_text,repId,project,audit_time}],
   *   onJump?: (repId)=>void, selectRepId?: string
   * }
   */
  function open(opts) {
    if (typeof document === "undefined") return;
    close();

    const C = { W: 720, H: 272, L: 46, R: 16, T: 16, B: 26, MINSPAN: 2 };
    const all = (opts.points || []).slice().sort((a, b) => a.t - b.t);
    const st = {
      opts,
      range: "all",
      filtered: all,
      i0: 0,
      i1: Math.max(all.length - 1, 0),
      sel: null,      // 选中的点（filtered 下标）
      hover: null,    // 十字线点（filtered 下标）
      colors: themeColors(),
      ptrs: new Map(),
      pan: null,
      pinch: null,
      downInfo: null,
    };

    const el = document.createElement("div");
    el.className = "hc-modal-mask";
    el.innerHTML =
      '<div class="hc-modal" role="dialog" aria-modal="true">' +
      '<div class="hc-m-head"><div class="hc-m-title">' + esc(opts.title) +
      (opts.tag ? ' <span class="mtag">' + esc(opts.tag) + "</span>" : "") +
      '</div><button class="hc-m-close" aria-label="关闭">✕</button></div>' +
      '<div class="hc-m-stats"></div>' +
      '<div class="hc-m-bar"><div class="hc-m-ranges"></div>' +
      '<div class="hc-m-zoom"><button class="hc-zbtn" data-z="in" title="放大">＋</button>' +
      '<button class="hc-zbtn" data-z="out" title="缩小">−</button>' +
      '<button class="hc-zbtn" data-z="reset" title="复位">⟲</button></div></div>' +
      '<div class="hc-m-chart"><svg class="hc-svg" viewBox="0 0 ' + C.W + " " + C.H + '"></svg><div class="hc-tip" hidden></div></div>' +
      '<div class="hc-m-detail"></div>' +
      '<div class="hc-m-hint">拖动平移 · 双指/滚轮缩放 · 点圆点查看来源报告</div>' +
      "</div>";
    document.body.appendChild(el);
    st.el = el;
    st.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const svg = el.querySelector(".hc-svg");
    const tip = el.querySelector(".hc-tip");
    const statsEl = el.querySelector(".hc-m-stats");
    const detailEl = el.querySelector(".hc-m-detail");
    const rangesEl = el.querySelector(".hc-m-ranges");

    /* ---------- 数据与视图 ---------- */
    function applyRange() {
      if (st.range === "all") {
        st.filtered = all;
      } else {
        const lastT = all.length ? all[all.length - 1].t : 0;
        st.filtered = all.filter((p) => p.t >= lastT - st.range * 864e5);
      }
      const n = st.filtered.length;
      st.i0 = 0;
      st.i1 = Math.max(n - 1, 0);
      st.sel = null;
      st.hover = null;
      if (st.opts.selectRepId) {
        for (let i = n - 1; i >= 0; i--) {
          if (st.filtered[i].repId === st.opts.selectRepId) {
            st.sel = i;
            const half = Math.max(4, Math.floor(n / 4));
            st.i0 = i - half;
            st.i1 = i + half;
            clampView();
            break;
          }
        }
        st.opts.selectRepId = null; // 仅首次定位
      }
    }

    function clampView() {
      const n = st.filtered.length;
      if (n <= 1) { st.i0 = 0; st.i1 = Math.max(n - 1, 0); return; }
      let span = st.i1 - st.i0;
      const maxSpan = n - 1;
      if (span > maxSpan) { span = maxSpan; }
      if (span < C.MINSPAN) span = Math.min(C.MINSPAN, maxSpan);
      if (st.i0 < 0) st.i0 = 0;
      if (st.i0 + span > maxSpan) st.i0 = maxSpan - span;
      if (st.i0 < 0) st.i0 = 0;
      st.i1 = st.i0 + span;
    }

    function zoomAt(frac, factor) {
      const n = st.filtered.length;
      if (n <= 1) return;
      const span = st.i1 - st.i0;
      const centerIdx = st.i0 + span * frac;
      let newSpan = span * factor;
      newSpan = Math.max(C.MINSPAN, Math.min(n - 1, newSpan));
      st.i0 = centerIdx - newSpan * frac;
      st.i1 = st.i0 + newSpan;
      clampView();
      render();
    }

    /* ---------- 渲染 ---------- */
    function renderStats() {
      const s = statsOf(st.filtered);
      if (!s) { statsEl.innerHTML = ""; return; }
      const dTxt = s.delta === null ? "—" : (s.delta > 0 ? "↑" : s.delta < 0 ? "↓" : "±") + fmt(Math.abs(s.delta));
      statsEl.innerHTML =
        chip("最高", fmt(s.max)) + chip("最低", fmt(s.min)) + chip("均值", fmt(s.avg)) +
        chip("异常", s.abn + " 点", s.abn ? "warn" : "") + chip("较上次", dTxt);
      function chip(label, v, cls) {
        return '<div class="hc-chip' + (cls ? " " + cls : "") + '"><b>' + esc(v) + "</b><span>" + esc(label) + "</span></div>";
      }
    }

    function renderRanges() {
      rangesEl.innerHTML = RANGES.map(function (r) {
        return '<button class="hc-rbtn' + (String(st.range) === String(r[0]) ? " on" : "") + '" data-r="' + r[0] + '">' + r[1] + "</button>";
      }).join("");
    }

    function render() {
      const cols = st.colors;
      const pts = st.filtered;
      const n = pts.length;
      const plotW = C.W - C.L - C.R;
      const plotH = C.H - C.T - C.B;
      if (!n) {
        svg.innerHTML = '<text x="' + C.W / 2 + '" y="' + C.H / 2 + '" font-size="13" text-anchor="middle" fill="' + cols.label + '">该时间范围内无数据</text>';
        detailEl.innerHTML = "";
        return;
      }
      const span = Math.max(st.i1 - st.i0, 0.0001);
      const X = (i) => C.L + ((i - st.i0) / span) * plotW;

      const first = Math.max(0, Math.floor(st.i0));
      const last = Math.min(n - 1, Math.ceil(st.i1));
      const vis = [];
      for (let i = first; i <= last; i++) vis.push(i);

      const vals = [];
      for (const i of vis) {
        if (Number.isFinite(pts[i].v)) vals.push(pts[i].v);
        const rlo = parseFloat(pts[i].ref_lo), rhi = parseFloat(pts[i].ref_hi);
        if (Number.isFinite(rlo)) vals.push(rlo);
        if (Number.isFinite(rhi)) vals.push(rhi);
      }
      if (!vals.length) vals.push(0, 1);
      let lo = Math.min.apply(null, vals);
      let hi = Math.max.apply(null, vals);
      if (hi === lo) { hi += 1; lo -= 1; }
      const pad = (hi - lo) * 0.15;
      lo -= pad; hi += pad;
      const Y = (v) => C.T + plotH * (1 - (v - lo) / (hi - lo));

      let s = '<defs><clipPath id="hcclip"><rect x="' + C.L + '" y="' + C.T + '" width="' + plotW + '" height="' + plotH + '"/></clipPath></defs>';

      // 分段参考区间带：每段对应该点所属报告的参考范围，区间变化肉眼可见
      const seg = plotW / span;
      s += '<g clip-path="url(#hcclip)">';
      for (const i of vis) {
        const rlo = parseFloat(pts[i].ref_lo), rhi = parseFloat(pts[i].ref_hi);
        if (!Number.isFinite(rlo) || !Number.isFinite(rhi) || rhi <= rlo) continue;
        const x1 = i === 0 ? C.L : X(i) - seg / 2;
        const x2 = i === n - 1 ? C.W - C.R : X(i) + seg / 2;
        s += '<rect x="' + x1.toFixed(1) + '" y="' + Y(rhi).toFixed(1) + '" width="' + Math.max(x2 - x1, 0.5).toFixed(1) +
          '" height="' + Math.max(Y(rlo) - Y(rhi), 0.5).toFixed(1) + '" fill="' + cols.band + '"/>';
      }
      // 网格
      for (let g = 1; g <= 3; g++) {
        const gy = C.T + plotH * (g / 4);
        s += '<line x1="' + C.L + '" y1="' + gy.toFixed(1) + '" x2="' + (C.W - C.R) + '" y2="' + gy.toFixed(1) + '" stroke="' + cols.grid + '" stroke-width="1"/>';
      }
      // 折线 + 面积
      if (vis.length > 1) {
        let d = "";
        for (let k = 0; k < vis.length; k++) {
          const i = vis[k];
          d += (k ? "L" : "M") + X(i).toFixed(1) + "," + Y(pts[i].v).toFixed(1);
        }
        s += '<path d="' + d + " L" + X(vis[vis.length - 1]).toFixed(1) + "," + (C.T + plotH) + " L" + X(vis[0]).toFixed(1) + "," + (C.T + plotH) + ' Z" fill="' + cols.area + '"/>';
        s += '<path d="' + d + '" fill="none" stroke="' + cols.line + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
      }
      // 数据点（异常点稍大）
      const showVal = seg >= 46; // 放大到足够宽时把数值直接标在点上
      for (const i of vis) {
        const p = pts[i];
        const color = p.flag === "↑" ? cols.hi : p.flag === "↓" ? cols.lo : cols.line;
        const r = st.sel === i ? 5 : p.flag === "↑" || p.flag === "↓" ? 3.8 : 3.2;
        s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="' + r + '" fill="' + color + '"' +
          (st.sel === i ? ' stroke="#fff" stroke-width="2"' : "") + "/>";
        if (showVal) {
          s += '<text x="' + X(i).toFixed(1) + '" y="' + (Y(p.v) - 7).toFixed(1) + '" font-size="10" font-weight="600" text-anchor="middle" fill="' + color + '">' + esc(fmt(p.v)) + "</text>";
        }
      }
      // 十字线
      if (st.hover !== null && st.hover >= first && st.hover <= last) {
        const hx = X(st.hover);
        s += '<line x1="' + hx.toFixed(1) + '" y1="' + C.T + '" x2="' + hx.toFixed(1) + '" y2="' + (C.T + plotH) + '" stroke="' + cols.cross + '" stroke-width="1" stroke-dasharray="3 3"/>';
      }
      s += "</g>";

      // Y 轴刻度
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4;
        const gy = Y(v);
        s += '<text x="' + (C.L - 6) + '" y="' + (gy + 3).toFixed(1) + '" font-size="9.5" text-anchor="end" fill="' + cols.label + '">' + esc(fmt(v)) + "</text>";
      }
      // X 轴日期标签（抽稀）
      const visCount = last - first + 1;
      const step = Math.max(1, Math.ceil(visCount / 6));
      for (let k = 0; k < vis.length; k++) {
        const i = vis[k];
        if (k % step !== 0 && i !== last) continue;
        s += '<text x="' + X(i).toFixed(1) + '" y="' + (C.H - 7) + '" font-size="9.5" text-anchor="middle" fill="' + cols.label + '">' + esc(pts[i].day) + "</text>";
      }
      // 最新参考区间标注（右上）
      const lp = pts[n - 1];
      const lrlo = parseFloat(lp.ref_lo), lrhi = parseFloat(lp.ref_hi);
      if (Number.isFinite(lrlo) && Number.isFinite(lrhi) && lrhi > lrlo) {
        s += '<text x="' + (C.W - C.R - 2) + '" y="' + (Y(lrhi) + 10).toFixed(1) + '" font-size="9" text-anchor="end" fill="' + cols.bandEdge + '">参考 ' + esc(fmt(lrlo)) + "~" + esc(fmt(lrhi)) + "</text>";
      }
      svg.innerHTML = s;

      renderDetail();
    }

    function renderDetail() {
      if (st.sel === null || !st.filtered[st.sel]) {
        detailEl.innerHTML = "";
        detailEl.hidden = true;
        return;
      }
      const p = st.filtered[st.sel];
      const prev = st.sel > 0 ? st.filtered[st.sel - 1] : null;
      const d = prev && Number.isFinite(prev.v) ? p.v - prev.v : null;
      const cls = p.flag === "↑" ? "hi" : p.flag === "↓" ? "lo" : "ok";
      const arrow = p.flag === "↑" ? "↑偏高" : p.flag === "↓" ? "↓偏低" : "正常";
      detailEl.hidden = false;
      detailEl.innerHTML =
        '<div class="hc-pt-top"><span class="hc-pt-v ' + cls + '">' + esc(fmt(p.v)) + "</span>" +
        '<span class="badge ' + cls + '">' + arrow + "</span>" +
        (d !== null ? '<span class="hc-pt-d">较上一点 ' + (d > 0 ? "↑" : d < 0 ? "↓" : "±") + esc(fmt(Math.abs(d))) + "</span>" : "") +
        "</div>" +
        '<div class="hc-pt-sub">📅 ' + esc(p.date) + (p.tm ? " " + esc(p.tm) : "") + (p.ref_text ? " · 参考 " + esc(p.ref_text) : "") + "</div>" +
        '<div class="hc-pt-src">来源：' + esc(p.project) + " · 审核 " + esc(p.audit_time) + (p.repId ? " · 标本号 " + esc(p.repId) : "") + "</div>" +
        (p.repId ? '<button class="hc-pt-jump">查看该报告 ↓</button>' : "");
      const btn = detailEl.querySelector(".hc-pt-jump");
      if (btn) btn.addEventListener("click", function () {
        if (typeof st.opts.onJump === "function") st.opts.onJump(p.repId);
      });
    }

    /* ---------- 交互 ---------- */
    function xToIdx(clientX) {
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / Math.max(rect.width, 1)) * C.W;
      const span = Math.max(st.i1 - st.i0, 0.0001);
      return st.i0 + ((vx - C.L) / (C.W - C.L - C.R)) * span;
    }
    function nearestIdx(clientX) {
      const idx = Math.round(xToIdx(clientX));
      return Math.max(0, Math.min(st.filtered.length - 1, idx));
    }
    function scheduleRender() {
      if (st.raf) return;
      st.raf = requestAnimationFrame(function () { st.raf = null; render(); });
    }

    const wrap = el.querySelector(".hc-m-chart");
    wrap.addEventListener("pointerdown", function (e) {
      wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId);
      st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientX });
      st.ptrs.get(e.pointerId).y = e.clientY;
      if (st.ptrs.size === 1) {
        st.pan = { x: e.clientX, i0: st.i0, i1: st.i0 + (st.i1 - st.i0) };
        st.downInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      } else if (st.ptrs.size === 2) {
        const ps = [...st.ptrs.values()];
        const span = st.i1 - st.i0;
        st.pinch = {
          d0: Math.abs(ps[0].x - ps[1].x) || 1,
          cx: (ps[0].x + ps[1].x) / 2,
          i0: st.i0, span,
        };
        st.pan = null;
      }
      st.hover = null;
      tip.hidden = true;
    });
    wrap.addEventListener("pointermove", function (e) {
      if (st.ptrs.has(e.pointerId)) st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.pinch && st.ptrs.size >= 2) {
        const ps = [...st.ptrs.values()];
        const d1 = Math.abs(ps[0].x - ps[1].x) || 1;
        const cx = (ps[0].x + ps[1].x) / 2;
        const rect = svg.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, ((cx - rect.left) / Math.max(rect.width, 1)) * C.W - C.L) / (C.W - C.L - C.R));
        const centerIdx = st.pinch.i0 + st.pinch.span * frac;
        let newSpan = st.pinch.span * (st.pinch.d0 / d1);
        newSpan = Math.max(C.MINSPAN, Math.min(st.filtered.length - 1, newSpan));
        st.i0 = centerIdx - newSpan * frac;
        st.i1 = st.i0 + newSpan;
        clampView();
        scheduleRender();
        return;
      }
      if (st.pan && st.ptrs.size === 1) {
        const rect = svg.getBoundingClientRect();
        const pxPerIdx = Math.max(rect.width, 1) / C.W * (C.W - C.L - C.R) / Math.max(st.pan.i1 - st.pan.i0, 0.0001);
        const dx = e.clientX - st.pan.x;
        if (st.downInfo && Math.abs(dx) + Math.abs(e.clientY - st.downInfo.y) > 7) st.downInfo.moved = true;
        const span = st.pan.i1 - st.pan.i0;
        st.i0 = st.pan.i0 - dx / pxPerIdx;
        st.i1 = st.i0 + span;
        clampView();
        scheduleRender();
        return;
      }
      // 无按键移动（鼠标悬停）→ 十字线气泡
      if (e.pointerType === "mouse" && st.ptrs.size === 0) {
        const i = nearestIdx(e.clientX);
        st.hover = i;
        const p = st.filtered[i];
        if (p) {
          const rect = svg.getBoundingClientRect();
          const span = Math.max(st.i1 - st.i0, 0.0001);
          const px = ((i - st.i0) / span) * (C.W - C.L - C.R) + C.L;
          tip.hidden = false;
          tip.style.left = Math.min(Math.max((px / C.W) * rect.width, 40), rect.width - 40) + "px";
          tip.style.top = "6px";
          tip.innerHTML = "<b>" + esc(fmt(p.v)) + "</b> " + esc(p.flag || "") + " · " + esc(p.day) +
            (p.ref_text ? '<br><span class="hc-tip-ref">参考 ' + esc(p.ref_text) + "</span>" : "");
        }
        scheduleRender();
      }
    });
    function endPointer(e) {
      const wasPan = st.pan;
      st.ptrs.delete(e.pointerId);
      if (st.ptrs.size < 2) st.pinch = null;
      if (st.ptrs.size === 0) {
        st.pan = null;
        // 轻点（未拖动、短时）→ 选中最近的点
        if (st.downInfo && !st.downInfo.moved && Date.now() - st.downInfo.t < 600 && wasPan) {
          st.sel = nearestIdx(e.clientX);
          render();
        }
        st.downInfo = null;
      }
    }
    wrap.addEventListener("pointerup", endPointer);
    wrap.addEventListener("pointercancel", endPointer);
    wrap.addEventListener("pointerleave", function (e) {
      if (st.ptrs.size === 0) { st.hover = null; tip.hidden = true; scheduleRender(); }
    });
    wrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (((e.clientX - rect.left) / Math.max(rect.width, 1)) * C.W - C.L) / (C.W - C.L - C.R)));
      zoomAt(frac, e.deltaY > 0 ? 1.25 : 0.8);
    }, { passive: false });
    wrap.addEventListener("dblclick", function () { applyRange(); render(); });

    el.querySelector(".hc-m-close").addEventListener("click", close);
    el.addEventListener("click", function (e) { if (e.target === el) close(); });
    st.onKey = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", st.onKey);

    rangesEl.addEventListener("click", function (e) {
      const b = e.target.closest ? e.target.closest(".hc-rbtn") : null;
      if (!b) return;
      const r = b.getAttribute("data-r");
      st.range = r === "all" ? "all" : parseInt(r, 10);
      applyRange();
      renderRanges();
      renderStats();
      render();
    });
    el.querySelector(".hc-m-zoom").addEventListener("click", function (e) {
      const b = e.target.closest ? e.target.closest(".hc-zbtn") : null;
      if (!b) return;
      const z = b.getAttribute("data-z");
      if (z === "reset") { applyRange(); render(); }
      else zoomAt(0.5, z === "in" ? 0.6 : 1.6);
    });

    // 系统主题切换时换配色重渲染
    if (typeof matchMedia !== "undefined") {
      try {
        st.mq = matchMedia("(prefers-color-scheme: dark)");
        st.mqHandler = function () { st.colors = themeColors(); render(); };
        if (st.mq.addEventListener) st.mq.addEventListener("change", st.mqHandler);
        else if (st.mq.addListener) st.mq.addListener(st.mqHandler);
      } catch {}
    }

    applyRange();
    renderRanges();
    renderStats();
    render();
    active = st;
  }

  root.HCChart = { open, close, _statsOf: statsOf };
})();
