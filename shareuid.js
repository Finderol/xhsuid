/*!
 * shareuid.js — 从小红书分享链接里还原分享者 uid（纯本地计算）
 *
 * 支持：
 *   - shareRedId：24 位 hex uid 的可逆编码（逐位加固定偏移后 Base64URL）
 *   - appuid / shareuid / uid 等明文字段
 *   - 参数里套 URL 的情况（如 /404/sec_xxx?originalUrl=<encoded>）
 *
 * 不联网、不上传、无依赖。浏览器用 <script src> 加载，Node 用 require()。
 * 算法出处：https://cnlnn.pages.dev/posts/share-link-identity-tracking/ (CC BY-NC-SA 4.0)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShareUid = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "1.0.0";

  var SHIFTS = [2, 6, 2, 0, 3, 5, 4, 9, 6, 7, 5, 2,
                9, 8, 0, 6, 6, 3, 9, 7, 4, 5, 6, 9];
  var UID_RE = /^[0-9a-f]{24}$/;
  var TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
  var URL_RE = /https?:\/\/[^\s<>"'，。；、！？【】（）《》]+/gi;
  var PLAIN_KEYS = ["appuid", "shareuid", "share_uid", "uid", "userid", "user_id"];

  function b64urlToBytes(token) {
    var b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** shareRedId -> 24 位小写 hex uid；失败抛 Error */
  function decodeShareRedId(token) {
    if (!TOKEN_RE.test(String(token || ""))) {
      throw new Error("shareRedId 不是 32 位 Base64URL 字符");
    }
    var raw = b64urlToBytes(token);
    if (raw.length !== 24) throw new Error("shareRedId 解码后不是 24 字节");
    var chars = "";
    for (var i = 0; i < 24; i++) {
      chars += String.fromCharCode((raw[i] - SHIFTS[i]) & 0xff);
    }
    var uid = chars.toLowerCase();
    if (!UID_RE.test(uid)) {
      throw new Error("还原结果不是 24 位 hex uid（算法可能已变更）");
    }
    // 回编码校验，排除巧合
    if (encodeShareRedId(uid) !== token) throw new Error("回编码不一致");
    return uid;
  }

  /** uid -> shareRedId（校验用） */
  function encodeShareRedId(uid) {
    uid = String(uid || "").toLowerCase();
    if (!UID_RE.test(uid)) throw new Error("uid 必须是 24 位 hex");
    var up = uid.toUpperCase();
    var bytes = new Uint8Array(24);
    for (var i = 0; i < 24; i++) {
      bytes[i] = (up.charCodeAt(i) + SHIFTS[i]) & 0xff;
    }
    return bytesToB64url(bytes);
  }

  function profileUrl(uid) {
    return "https://www.xiaohongshu.com/user/profile/" + uid;
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(String(s).replace(/\+/g, " "));
    } catch (e) {
      return String(s);
    }
  }

  /** 取出 URL 的查询参数，并递归进入"值本身是 URL"的参数 */
  function collectParams(url, depth, out) {
    if (depth > 3) return;
    var q = String(url).indexOf("?");
    if (q < 0) return;
    var query = String(url).slice(q + 1);
    var hash = query.indexOf("#");
    if (hash >= 0) query = query.slice(0, hash);
    var parts = query.split("&");
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i];
      if (!pair) continue;
      var eq = pair.indexOf("=");
      var key = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
      var value = eq < 0 ? "" : safeDecode(pair.slice(eq + 1));
      out.push([key, value]);
      if (/^https?:\/\//i.test(value)) collectParams(value, depth + 1, out);
    }
  }

  /** 从文本里抓 shareRedId / 明文 uid 字段（覆盖 originalUrl 被编码的情况） */
  function scanText(text, out) {
    var re = /shareRedId=([A-Za-z0-9_-]{32})/g;
    var m;
    while ((m = re.exec(text)) !== null) out.push(["shareRedId", m[1]]);

    for (var k = 0; k < PLAIN_KEYS.length; k++) {
      var key = PLAIN_KEYS[k];
      var re2 = new RegExp("(?:^|[?&])" + key + "=([0-9a-fA-F]{24})(?=[&#]|$)", "g");
      while ((m = re2.exec(text)) !== null) out.push([key, m[1].toLowerCase()]);
    }
  }

  /**
   * 解析任意文本（链接、分享文案、纯 token）
   * @returns {{urls: string[], uids: Array<{uid:string, field:string, profileUrl:string}>, errors: Array}}
   */
  function extract(text) {
    var input = String(text == null ? "" : text).trim();
    var urls = input.match(URL_RE) || [];
    urls = urls.map(function (u) { return u.replace(/[).,;!?'"]+$/, ""); });

    var found = [];
    if (!urls.length && TOKEN_RE.test(input)) found.push(["shareRedId", input]);

    for (var i = 0; i < urls.length; i++) {
      var pairs = [];
      collectParams(urls[i], 0, pairs);
      for (var j = 0; j < pairs.length; j++) found.push(pairs[j]);
    }
    scanText(input, found);
    try {
      var decoded = decodeURIComponent(input);
      if (decoded !== input) scanText(decoded, found);
    } catch (e) { /* 忽略非法转义 */ }

    // 同一字段/值可能被多个途径命中（URL 参数、原文扫描、解码后扫描），先去重
    var pairSeen = {};
    var uniquePairs = [];
    for (var p = 0; p < found.length; p++) {
      var pairKey = found[p][0] + "|" + found[p][1];
      if (pairSeen[pairKey]) continue;
      pairSeen[pairKey] = true;
      uniquePairs.push(found[p]);
    }
    found = uniquePairs;

    var seen = {};
    var uids = [];
    var errors = [];
    for (var n = 0; n < found.length; n++) {
      var field = found[n][0];
      var value = found[n][1];
      var uid = null;
      if (field === "shareRedId") {
        if (!TOKEN_RE.test(value)) continue;
        try {
          uid = decodeShareRedId(value);
        } catch (err) {
          errors.push({ field: field, value: value, error: err.message });
          continue;
        }
      } else {
        var lower = String(value).toLowerCase();
        if (!UID_RE.test(lower)) continue;
        uid = lower;
      }
      var dedupKey = uid + "|" + field;
      if (seen[dedupKey]) continue;
      seen[dedupKey] = true;
      uids.push({ uid: uid, field: field, profileUrl: profileUrl(uid) });
    }

    return { urls: urls, uids: uids, errors: errors };
  }

  return {
    version: VERSION,
    decodeShareRedId: decodeShareRedId,
    encodeShareRedId: encodeShareRedId,
    extract: extract
  };
});
