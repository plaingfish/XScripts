const TITLE = "SDGun 社区每日任务";
const NAMESPACE = "sdgun_daily_tasks";

const signDailyMax = 1; // 签到 每天最多 1 次
const threadDailyMax = 3; // 发帖 每天最多发 3 帖
const replyDailyMax = 10; // 回帖 每天最多发 10 条回复帖
const applaudDailyMax = 3; // 点赞 每天最多点赞 3 个帖子
const signPerRunMax = 1; // 单次运行最多签到 1 次
const threadPerRunMax = 1; // 单次运行最多发 1 帖
const replyPerRunMax = 4; // 单次运行最多回 4 帖
const applaudPerRunMax = 3; // 单次运行最多点赞 3 帖
const DAILY_PROGRESS_KEY = `${NAMESPACE}_daily_progress`;
const LATEST_THREAD_CACHE_KEY = `${NAMESPACE}_latest_thread`;
const publishCooldownMs = 30 * 1000; // 发帖与回帖之间的最小间隔
const threadIntervalMs = 30 * 1000;
const replyIntervalMs = 30 * 1000;
const applaudIntervalMs = 1 * 1000;

let $ = new Env(NAMESPACE, {
  logLevel: "info",
  log() {},
});

let arg;
if (typeof $argument != "undefined") {
  arg = Object.fromEntries($argument.split("&").map((item) => item.split("=")));
} else {
  arg = {};
}
// $.info(`传入的 $argument: ${$.toStr(arg)}`);

arg = { ...arg, ...$.getjson(NAMESPACE, {}) };
const replyOwnThreadOnly = normalizeBoolean(arg.reply_own_thread_only, false);

// $.info(`从持久化存储读取参数后: ${$.toStr(arg)}`);

let result = {};

!(async () => {
  if ((typeof $request !== "undefined") & (typeof $response !== "undefined")) {
    // $.info($.toStr($request.headers, {}, null, 2));
    // $.info($.toStr($response.body, {}, null, 2));
    const lowerCaseRequestHeaders = Object.fromEntries(
      Object.entries($request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );

    $request.headers = new Proxy(lowerCaseRequestHeaders, {
      get: function (target, propKey, receiver) {
        return Reflect.get(target, propKey.toLowerCase(), receiver);
      },
      set: function (target, propKey, value, receiver) {
        return Reflect.set(target, propKey.toLowerCase(), value, receiver);
      },
    });
    let body = $response.body;
    try {
      body = JSON.parse(body);
    } catch (e) {}
    $.setjson(
      {
        headers: $request.headers,
        body: $response.body,
      },
      `${NAMESPACE}`,
    );
    // await notify(TITLE, "获取到用户信息", "已保存");
  } else {
    const saved = $.getjson(`${NAMESPACE}`);
    if (!saved) throw new Error("请先获取用户信息");
    const dailyProgress = getDailyProgress();
    const tasks = [];
    $.info("ℹ️ 仅回复自己发的帖", replyOwnThreadOnly);
    const signRemaining = getRemainingDailyCount(
      dailyProgress,
      "sign",
      signDailyMax,
    );
    const signPlanned = getPlannedCount(signRemaining, signPerRunMax);
    try {
      if (!signPlanned) {
        $.info("⏭️ 签到任务 今日已达上限");
        tasks.push({
          name: "签到",
          status: "success",
          text: formatProgressText(dailyProgress.sign, signDailyMax),
        });
      } else {
        $.info("🚀 签到任务");
        await sign(saved);
        incrementDailyProgress(dailyProgress, "sign");
        tasks.push({
          name: "签到",
          status: "success",
          text: formatProgressText(
            dailyProgress.sign,
            signDailyMax,
            signPlanned,
          ),
        });
      }
    } catch (e) {
      $.logErr(e);
      $.logErr($.toStr(e));
      tasks.push({
        name: "签到",
        status: "fail",
        text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
      });
    }
    const replyRemaining = getRemainingDailyCount(
      dailyProgress,
      "reply",
      replyDailyMax,
    );
    const replyPlanned = getPlannedCount(replyRemaining, replyPerRunMax);
    const applaudRemaining = getRemainingDailyCount(
      dailyProgress,
      "applaud",
      applaudDailyMax,
    );
    const applaudPlanned = getPlannedCount(applaudRemaining, applaudPerRunMax);
    const threadRemaining = getRemainingDailyCount(
      dailyProgress,
      "thread",
      threadDailyMax,
    );
    const threadPlanned = getPlannedCount(threadRemaining, threadPerRunMax);
    let replyExecuted = 0;
    let threadExecuted = 0;
    let threadHandled = false;
    let list = [];
    let listError;
    if ((replyPlanned && !replyOwnThreadOnly) || applaudPlanned) {
      try {
        $.info("🚀 获取帖子");
        list = await fetchThreadIds(saved);
      } catch (e) {
        listError = e;
      }
    }
    if (replyOwnThreadOnly && replyPlanned && threadPlanned) {
      threadHandled = true;
      try {
        $.info(`🚀 发帖任务 本次计划 ${threadPlanned} 次，随后回复自己`);
        const threadResult = await thread(saved, threadPlanned, () =>
          incrementDailyProgress(dailyProgress, "thread"),
        );
        threadExecuted = threadResult.count;
        tasks.push({
          name: "发帖",
          status: "success",
          text: formatProgressText(
            dailyProgress.thread,
            threadDailyMax,
            threadResult.count,
          ),
        });
      } catch (e) {
        $.logErr(e);
        $.logErr($.toStr(e));
        tasks.push({
          name: "发帖",
          status: "fail",
          text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
        });
      }
    }
    try {
      if (!replyPlanned) {
        $.info("⏭️ 回帖任务 今日已达上限");
        tasks.push({
          name: "回帖",
          status: "success",
          text: formatProgressText(dailyProgress.reply, replyDailyMax),
        });
      } else {
        let replyList = list;
        if (replyOwnThreadOnly) {
          if (threadExecuted > 0) {
            $.info(
              `⏳ 回帖前等待 ${publishCooldownMs / 1000} 秒，避开发言间隔限制`,
            );
            await $.wait(publishCooldownMs);
          }
          const latestThreadId = getLatestThreadId();
          if (!latestThreadId) {
            throw new Error(
              "未找到可回复的自发帖 id，请先成功发帖一次或关闭 reply_own_thread_only",
            );
          }
          replyList = [latestThreadId];
          $.info(
            `🚀 回帖任务 仅回复自发帖 ${latestThreadId}，本次计划 ${replyPlanned} 次`,
          );
        } else {
          if (listError) throw listError;
          $.info(`🚀 回帖任务 本次计划 ${replyPlanned} 次`);
        }
        const count = await reply(saved, replyList, replyPlanned, () =>
          incrementDailyProgress(dailyProgress, "reply"),
        );
        replyExecuted = count;
        tasks.push({
          name: "回帖",
          status: "success",
          text: formatProgressText(dailyProgress.reply, replyDailyMax, count),
        });
      }
    } catch (e) {
      $.logErr(e);
      $.logErr($.toStr(e));
      tasks.push({
        name: "回帖",
        status: "fail",
        text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
      });
    }
    try {
      if (!applaudPlanned) {
        $.info("⏭️ 点赞任务 今日已达上限");
        tasks.push({
          name: "点赞",
          status: "success",
          text: formatProgressText(dailyProgress.applaud, applaudDailyMax),
        });
      } else {
        if (listError) throw listError;
        $.info(`🚀 点赞任务 本次计划 ${applaudPlanned} 次`);
        const count = await applaud(saved, list, applaudPlanned, () =>
          incrementDailyProgress(dailyProgress, "applaud"),
        );
        tasks.push({
          name: "点赞",
          status: "success",
          text: formatProgressText(
            dailyProgress.applaud,
            applaudDailyMax,
            count,
          ),
        });
      }
    } catch (e) {
      $.logErr(e);
      $.logErr($.toStr(e));
      tasks.push({
        name: "点赞",
        status: "fail",
        text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
      });
    }
    if (!threadHandled) {
      try {
        if (!threadPlanned) {
          $.info("⏭️ 发帖任务 今日已达上限");
          tasks.push({
            name: "发帖",
            status: "success",
            text: formatProgressText(dailyProgress.thread, threadDailyMax),
          });
        } else {
          if (replyExecuted > 0) {
            $.info(
              `⏳ 发帖前等待 ${publishCooldownMs / 1000} 秒，避开发言间隔限制`,
            );
            await $.wait(publishCooldownMs);
          }
          $.info(`🚀 发帖任务 本次计划 ${threadPlanned} 次`);
          const threadResult = await thread(saved, threadPlanned, () =>
            incrementDailyProgress(dailyProgress, "thread"),
          );
          threadExecuted = threadResult.count;
          tasks.push({
            name: "发帖",
            status: "success",
            text: formatProgressText(
              dailyProgress.thread,
              threadDailyMax,
              threadResult.count,
            ),
          });
        }
      } catch (e) {
        $.logErr(e);
        $.logErr($.toStr(e));
        tasks.push({
          name: "发帖",
          status: "fail",
          text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
        });
      }
    }
    try {
      $.info("🚀 领取奖励");
      await reward(saved);
      tasks.push({
        name: "领取奖励",
        status: "success",
      });
    } catch (e) {
      $.logErr(e);
      $.logErr($.toStr(e));
      tasks.push({
        name: "领取奖励",
        status: "fail",
        text: `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
      });
    }
    // 成功任务文案
    const successText = tasks
      .filter((t) => t.status === "success")
      .map((t) => (t.text ? `${t.name}(${t.text})` : `${t.name}`))
      .join(", ");
    // 失败任务文案
    const failText = tasks
      .filter((t) => t.status === "fail")
      .map((t) => `${t.name}(${t.text})`)
      .join("\n");
    await notify(
      `${TITLE}(${tasks.filter((t) => t.status === "success").length}/${tasks.length})`,
      successText ? `✅ ${successText}` : "",
      failText ? `❌ ${failText}` : "",
    );
  }
})()
  .catch(async (e) => {
    $.logErr(e);
    $.logErr($.toStr(e));
    await notify(
      TITLE,
      "❌",
      `${$.lodash_get(e, "message") || $.lodash_get(e, "error") || e}`,
    );
  })
  .finally(async () => {
    $.done(result);
  });

/**
 * 雅致万象生成器 (全原生逻辑，无 Intl 依赖)
 */
function generateGrandVerse() {
  // 1. 核心意象池 (正面、高雅、跨度极大)
  const pool = {
    micro: [
      "一粟",
      "寸心",
      "微茫",
      "毫端",
      "露电",
      "指尖",
      "孤萤",
      "残雪",
      "片羽",
      "幽兰",
      "清露",
      "尘芥",
    ],
    aesthetic: [
      "琉璃",
      "清梵",
      "昭华",
      "灵曜",
      "锦瑟",
      "冰弦",
      "瑶草",
      "星髓",
      "凤律",
      "玉烟",
      "翠微",
      "韶光",
    ],
    action: [
      "卷",
      "吐",
      "演",
      "撼",
      "化",
      "溯",
      "吞",
      "照",
      "映",
      "绽",
      "焕",
      "洗",
    ],
    macro: [
      "沧海",
      "大千",
      "万劫",
      "八荒",
      "九极",
      "星汉",
      "太虚",
      "春晖",
      "蓬莱",
      "九霄",
      "归墟",
      "鸿蒙",
    ],
  };

  const r = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // 检查两句是否有重复字
  const hasOverlap = (s1, s2) => {
    const chars = new Set(s1);
    for (let char of s2) {
      if (chars.has(char)) return true;
    }
    return false;
  };

  // 2. 生成两句七言 (严格去重)
  const buildLine = () =>
    `${r(pool.micro)}${r(pool.aesthetic)}${r(pool.motion || pool.action)}${r(pool.macro)}`;
  let line1 = buildLine();
  let line2 = buildLine();
  while (hasOverlap(line1, line2)) {
    line2 = buildLine();
  }

  // 3. 手动生成中文日期 (兼容无 Intl 环境)
  const now = new Date();
  const n = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const yearChn = now
    .getFullYear()
    .toString()
    .split("")
    .map((d) => n[d])
    .join("");
  const months = [
    "",
    "正月",
    "二月",
    "三月",
    "四月",
    "五月",
    "六月",
    "七月",
    "八月",
    "九月",
    "十月",
    "冬月",
    "腊月",
  ];
  const date = now.getDate();
  const dateChn =
    date <= 10
      ? "初" + n[date]
      : date < 20
        ? "十" + (date % 10 ? n[date % 10] : "")
        : date < 30
          ? "廿" + (date % 10 ? n[date % 10] : "")
          : "卅" + (date % 10 ? n[date % 10] : "");

  const dateLine = `${yearChn}年 ${months[now.getMonth() + 1]}${dateChn}`;

  return `${line1}\n${line2}\n—— 时维 ${dateLine}`;
}

/**
 * 高随机、无门槛、非观点性回帖生成器
 * 核心：15-25字，避开“观点/内容”等具体词汇，适配任何帖子
 */
function extremeRandomComment() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const pool = {
    // 1. 入场姿势（不带评价词）
    prefix: [
      "刚看到",
      "路过支持",
      "先刷到",
      "特意点进来",
      "前排围观",
      "准时报到",
    ],
    // 2. 互动行为（中性动作）
    action: [
      "仔细看了遍",
      "顺手留个爪",
      "这篇收下了",
      "认真读完",
      "默默关注了",
      "先回复一下",
    ],
    // 3. 通用状态（不涉及观点，只说个人感受）
    status: [
      "感觉挺不错",
      "确实有一手",
      "细节拉满了",
      "真的挺走心",
      "整体很到位",
      "这种风格好",
    ],
    // 4. 社区惯例（收尾）
    suffix: [
      "支持楼主！",
      "期待下一次。",
      "先赞后看。",
      "回帖奖励。",
      "收藏走起。",
      "加油加油！",
    ],
  };

  // 随机句式模板，打乱顺序增加随机感
  const templates = [
    () =>
      `${pick(pool.prefix)}，${pick(pool.action)}，${pick(pool.status)}${pick(pool.suffix)}`,
    () =>
      `${pick(pool.action)}，${pick(pool.prefix)}${pick(pool.status)}，${pick(pool.suffix)}`,
    () =>
      `${pick(pool.status)}！${pick(pool.action)}，${pick(pool.prefix)}，${pick(pool.suffix)}`,
  ];

  return pick(templates)();
}

function normalizeCount(value) {
  const count = parseInt(value || 0, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

function getLatestThreadId() {
  const saved = $.getjson(LATEST_THREAD_CACHE_KEY, {});
  const id =
    normalizeCount(saved?.threadId) ||
    normalizeCount(saved?.id) ||
    normalizeCount(saved);
  return id || 0;
}

function saveLatestThreadId(id) {
  const threadId = normalizeCount(id);
  if (!threadId) return false;
  return $.setjson(
    {
      threadId,
      updatedAt: Date.now(),
    },
    LATEST_THREAD_CACHE_KEY,
  );
}

function getDailyProgress() {
  const date = $.time("yyyy-MM-dd");
  const saved = $.getjson(DAILY_PROGRESS_KEY, {});
  const progress =
    saved?.date === date
      ? {
          date,
          sign: normalizeCount(saved.sign),
          thread: normalizeCount(saved.thread),
          reply: normalizeCount(saved.reply),
          applaud: normalizeCount(saved.applaud),
        }
      : {
          date,
          sign: 0,
          thread: 0,
          reply: 0,
          applaud: 0,
        };
  saveDailyProgress(progress);
  return progress;
}

function saveDailyProgress(progress) {
  $.setjson(progress, DAILY_PROGRESS_KEY);
}

function incrementDailyProgress(progress, key) {
  progress[key] = normalizeCount(progress[key]) + 1;
  saveDailyProgress(progress);
}

function getRemainingDailyCount(progress, key, dailyMax) {
  return Math.max(0, dailyMax - normalizeCount(progress[key]));
}

function getPlannedCount(remaining, perRunMax) {
  return Math.max(
    0,
    Math.min(normalizeCount(remaining), normalizeCount(perRunMax)),
  );
}

function formatProgressText(current, max, executed = 0) {
  if (!executed) return `今日 ${current}/${max}`;
  return `本次 ${executed} 次，今日 ${current}/${max}`;
}

async function fetchThreadIds(saved) {
  const res = await http({
    method: "get",
    // url: `https://mag1.sdgun.net/mag/circle/v1/show/contentNewv3?cat_type_id=2&circle_id=205&p=1&step=20`,
    url: `https://mag1.sdgun.net/mag/circle/v2/forum/forumViewV2?cat_type_id=20&circle_id=197&fid=188&p=1&step=20`,
    headers: {
      ...saved.headers,
    },
  });
  const status =
    $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  $.info("ℹ️ res status", status);
  let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  try {
    body = JSON.parse(body);
  } catch (e) {}
  const list = Array.from(
    new Set(
      ($.lodash_get(body, "list") || [])
        .map((i) => $.lodash_get(i, "tid"))
        .filter(Boolean),
    ),
  );
  $.info("ℹ️ 帖子 id", list);
  if (!list.length) {
    throw new Error("未获取到可操作帖子");
  }
  return list;
}

function buildExecutionIds(list, count) {
  const ids = Array.from(new Set((list || []).filter(Boolean)));
  if (!ids.length) {
    throw new Error("未获取到可操作帖子");
  }
  if (count <= ids.length) {
    return ids.slice(0, count);
  }
  const expanded = [];
  for (let i = 0; i < count; i++) {
    expanded.push(ids[i % ids.length]);
  }
  return expanded;
}
// 签到
async function sign(saved) {
  const uid = saved.body?.data?.extra?.user_id;
  const res = await http({
    url: `https://shuidan.app1.magcloud.net/mag/addon/v1/sign/signReward?uid=${uid}`,
    headers: {
      ...saved.headers,
    },
  });
  const status =
    $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  $.info("ℹ️ res status", status);
  let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  $.info("ℹ️ res body", body);
  try {
    body = JSON.parse(body);
  } catch (e) {}
  // $.info($.toStr(body, {}, null, 2));
  const baseGoldReward = parseInt(
    $.lodash_get(body, "data.gold.baseGoldReward") || 0,
    10,
  );
  const extraGoldReward = parseInt(
    $.lodash_get(body, "data.gold.extraGoldReward") || 0,
    10,
  );

  if (!baseGoldReward && !extraGoldReward) {
    throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
  }
  return {
    baseGoldReward,
    extraGoldReward,
  };
  // await notify(
  //   TITLE,
  //   `签到成功`,
  //   `获得: ${baseGoldReward} + ${extraGoldReward} = ${
  //     baseGoldReward + extraGoldReward
  //   }`,
  // );
}
// 点赞
async function applaud(saved, list, count, onSuccess) {
  const ids = buildExecutionIds(list, count);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const res = await http({
      // url: `https://mag1.sdgun.net/mag/circle/v1/show/contentAddApplaud`,
      url: `https://mag1.sdgun.net/mag/circle/v1/Forum/contentAddApplaud`,
      body: `content_id=${id}`,
      headers: {
        ...saved.headers,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const status =
      $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
    $.info("ℹ️ res status", status);
    let body = String(
      $.lodash_get(res, "body") || $.lodash_get(res, "rawBody"),
    );
    $.info("ℹ️ res body", body);
    try {
      body = JSON.parse(body);
    } catch (e) {}

    if (!$.lodash_get(body, "success")) {
      throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
    }

    if (typeof onSuccess === "function") onSuccess(id);
    if (i < ids.length - 1) {
      await $.wait(applaudIntervalMs);
    }
  }
  return ids.length;
  // const res = await http({
  //   url: `https://mag1.sdgun.net/mag/user/v1/GradeScore/getScoreTaskReward?id=17331552`,
  //   headers: {
  //     ...saved.headers,
  //   },
  // });
  // const status =
  //   $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  // $.info("ℹ️ res status", status);
  // let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  // $.info("ℹ️ res body", body);
  // try {
  //   body = JSON.parse(body);
  // } catch (e) {}

  // if (!$.lodash_get(body, "success")) {
  //   throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
  // }
  // return $.lodash_get(body, "data.score_change_str") || "";
}
// 评论
async function reply(saved, list, count, onSuccess) {
  const ids = buildExecutionIds(list, count);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const res = await http({
      // url: `https://mag1.sdgun.net/mag/circle/v2/show/contentAddComment`,
      url: `https://mag1.sdgun.net/mag/circle/v1/Forum/replyAdd`,
      // body: `content=${encodeURIComponent(extremeRandomComment())}&content_id=${id}&is_turn=-1&network_state=1&source=qiniu`,
      body: `source=qiniu&from_push=&tid=${id}&circle_id=197&content=${encodeURIComponent(extremeRandomComment())}&auth=&video=&vest_id=`,
      headers: {
        ...saved.headers,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const status =
      $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
    $.info("ℹ️ res status", status);
    let body = String(
      $.lodash_get(res, "body") || $.lodash_get(res, "rawBody"),
    );
    $.info("ℹ️ res body", body);
    try {
      body = JSON.parse(body);
    } catch (e) {}

    if (!$.lodash_get(body, "success")) {
      throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
    }

    if (typeof onSuccess === "function") onSuccess(id);
    if (i < ids.length - 1) {
      await $.wait(replyIntervalMs);
    }
  }
  return ids.length;
  // const res = await http({
  //   url: `https://mag1.sdgun.net/mag/user/v1/GradeScore/getScoreTaskReward?id=17331878`,
  //   headers: {
  //     ...saved.headers,
  //   },
  // });
  // const status =
  //   $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  // $.info("ℹ️ res status", status);
  // let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  // $.info("ℹ️ res body", body);
  // try {
  //   body = JSON.parse(body);
  // } catch (e) {}

  // if (!$.lodash_get(body, "success")) {
  //   throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
  // }
  // return $.lodash_get(body, "data.score_change_str") || "";
}
// 发帖
async function thread(saved, count, onSuccess) {
  const createdIds = [];
  for (let i = 0; i < count; i++) {
    const content = generateGrandVerse();
    const res = await http({
      // url: `https://mag1.sdgun.net/mag/circle/v3/show/contentAdd`,
      url: `https://mag1.sdgun.net/mag/circle/v1/forum/threadAdd`,
      // body: `can_copy=1&can_down=1&can_origin_pic=-1&circle_id=205&client_type=iPhone16%2C2&content=${encodeURIComponent(content)}&is_origin=-1&is_sync_home_page=1&network_state=1`,
      body: `circle_id=197&classified_id=0&content=${encodeURIComponent(JSON.stringify([{ content, type: "text" }]))}&fid=188&network_state=1&title=${encodeURIComponent("今日诗词分享")}&type_id=115&users=`,
      headers: {
        ...saved.headers,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const status =
      $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
    $.info("ℹ️ res status", status);
    let body = String(
      $.lodash_get(res, "body") || $.lodash_get(res, "rawBody"),
    );
    $.info("ℹ️ res body", body);
    try {
      body = JSON.parse(body);
    } catch (e) {}

    if (!$.lodash_get(body, "success")) {
      throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
    }
    const threadId = normalizeCount(
      $.lodash_get(body, "sharedata.type_value") ||
        $.lodash_get(body, "data.type_value") ||
        $.lodash_get(body, "type_value"),
    );
    if (threadId) {
      saveLatestThreadId(threadId);
      createdIds.push(threadId);
    } else {
      $.warn("⚠️ 发帖成功，但未从响应中提取到帖子 id");
    }
    if (typeof onSuccess === "function") onSuccess(threadId || i);
    if (i < count - 1) {
      await $.wait(threadIntervalMs);
    }
  }
  return {
    count,
    ids: createdIds,
    latestId: createdIds[createdIds.length - 1] || 0,
  };
  // const res = await http({
  //   url: `https://mag1.sdgun.net/mag/user/v1/GradeScore/getScoreTaskReward?id=17331878`,
  //   headers: {
  //     ...saved.headers,
  //   },
  // });
  // const status =
  //   $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  // $.info("ℹ️ res status", status);
  // let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  // $.info("ℹ️ res body", body);
  // try {
  //   body = JSON.parse(body);
  // } catch (e) {}

  // if (!$.lodash_get(body, "success")) {
  //   throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
  // }
  // return $.lodash_get(body, "data.score_change_str") || "";
}
// 领取奖励
async function reward(saved) {
  const res = await http({
    url: `https://mag1.sdgun.net//mag/user/v1/user/task?themecolor=111111`,
    headers: {
      ...saved.headers,
    },
  });
  const status =
    $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
  $.info("ℹ️ res status", status);
  let body = String($.lodash_get(res, "body") || $.lodash_get(res, "rawBody"));
  // $.info("ℹ️ res body", body);
  const regex = /"user_mission_id":\s*(\d+)/g;
  const ids = [];
  let match;

  while ((match = regex.exec(body)) !== null) {
    // match[1] 是正则表达式中括号捕获的内容（即 ID 数字）
    ids.push(Number(match[1]));
  }
  $.info("ℹ️ 任务 ID 列表", ids);

  for await (const id of ids) {
    const res = await http({
      url: `https://mag1.sdgun.net/mag/user/v1/GradeScore/getScoreTaskReward?id=${id}`,
      headers: {
        ...saved.headers,
      },
    });
    const status =
      $.lodash_get(res, "status") || $.lodash_get(res, "statusCode") || 200;
    $.info("ℹ️ res status", status);
    let body = String(
      $.lodash_get(res, "body") || $.lodash_get(res, "rawBody"),
    );
    $.info("ℹ️ res body", body);
    try {
      body = JSON.parse(body);
    } catch (e) {}

    if (!$.lodash_get(body, "success")) {
      throw new Error(`${$.lodash_get(body, "msg") || "未知错误"}`);
    }
    await $.wait(5 * 1000);
  }
}

// 请求
async function http(opt = {}) {
  const TIMEOUT = parseFloat(opt.timeout || $.lodash_get(arg, "TIMEOUT") || 5);
  const RETRIES = parseFloat(opt.retries || $.lodash_get(arg, "RETRIES") || 1);
  const RETRY_DELAY = parseFloat(
    opt.retry_delay || $.lodash_get(arg, "RETRY_DELAY") || 1,
  );

  let timeout = TIMEOUT + 1;
  timeout = $.isSurge() ? timeout : timeout * 1000;

  let count = 0;
  const fn = async () => {
    try {
      if (TIMEOUT) {
        // Surge, Loon, Stash 默认为 5 秒
        return await Promise.race([
          $.http.post({ ...opt, timeout }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("HTTP TIMEOUT")), TIMEOUT * 1000),
          ),
        ]);
      }
      return await $.http.post(opt);
    } catch (e) {
      if (count < RETRIES) {
        count++;
        $.log(
          `第 ${count} 次请求失败: ${
            e.message || e
          }, 等待 ${RETRY_DELAY}s 后重试`,
        );
        await $.wait(RETRY_DELAY * 1000);
        return await fn();
      }
    }
  };
  return await fn();
}
// 通知
async function notify(title, subt, body, opts) {
  $.msg(title, subt, body, opts);
}

// prettier-ignore
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise(((e,i)=>{s.call(this,t,((t,s,o)=>{t?i(t):e(s)}))}))}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.logLevels={debug:0,info:1,warn:2,error:3},this.logLevelPrefixs={debug:"[DEBUG] ",info:"[INFO] ",warn:"[WARN] ",error:"[ERROR] "},this.logLevel="info",this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.encoding="utf-8",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`🔔${this.name}, 开始!`)}getEnv(){return"undefined"!=typeof $environment&&$environment["surge-version"]?"Surge":"undefined"!=typeof $environment&&$environment["stash-version"]?"Stash":"undefined"!=typeof module&&module.exports?"Node.js":"undefined"!=typeof $task?"Quantumult X":"undefined"!=typeof $loon?"Loon":"undefined"!=typeof $rocket?"Shadowrocket":void 0}isNode(){return"Node.js"===this.getEnv()}isQuanX(){return"Quantumult X"===this.getEnv()}isSurge(){return"Surge"===this.getEnv()}isLoon(){return"Loon"===this.getEnv()}isShadowrocket(){return"Shadowrocket"===this.getEnv()}isStash(){return"Stash"===this.getEnv()}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null,...s){try{return JSON.stringify(t,...s)}catch{return e}}getjson(t,e){let s=e;if(this.getdata(t))try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise((e=>{this.get({url:t},((t,s,i)=>e(i)))}))}runScript(t,e){return new Promise((s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let o=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");o=o?1*o:20,o=e&&e.timeout?e.timeout:o;const[r,a]=i.split("@"),n={url:`http://${a}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:o},headers:{"X-Key":r,Accept:"*/*"},timeout:o};this.post(n,((t,e,i)=>s(i)))})).catch((t=>this.logErr(t)))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),o=JSON.stringify(this.data);s?this.fs.writeFileSync(t,o):i?this.fs.writeFileSync(e,o):this.fs.writeFileSync(t,o)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let o=t;for(const t of i)if(o=Object(o)[t],void 0===o)return s;return o}lodash_set(t,e,s){return Object(t)!==t||(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce(((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{}),t)[e[e.length-1]]=s),t}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),o=s?this.getval(s):"";if(o)try{const t=JSON.parse(o);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,o]=/^@(.*?)\.(.*?)$/.exec(e),r=this.getval(i),a=i?"null"===r?null:r||"{}":"{}";try{const e=JSON.parse(a);this.lodash_set(e,o,t),s=this.setval(JSON.stringify(e),i)}catch(e){const r={};this.lodash_set(r,o,t),s=this.setval(JSON.stringify(r),i)}}else s=this.setval(t,e);return s}getval(t){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.read(t);case"Quantumult X":return $prefs.valueForKey(t);case"Node.js":return this.data=this.loaddata(),this.data[t];default:return this.data&&this.data[t]||null}}setval(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.write(t,e);case"Quantumult X":return $prefs.setValueForKey(t,e);case"Node.js":return this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0;default:return this.data&&this.data[e]||null}}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.cookie&&void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar)))}get(t,e=(()=>{})){switch(t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"],delete t.headers["content-type"],delete t.headers["content-length"]),t.params&&(t.url+="?"+this.queryStr(t.params)),void 0===t.followRedirect||t.followRedirect||((this.isSurge()||this.isLoon())&&(t["auto-redirect"]=!1),this.isQuanX()&&(t.opts?t.opts.redirection=!1:t.opts={redirection:!1})),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,((t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,i)}));break;case"Quantumult X":this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then((t=>{const{statusCode:s,statusCode:i,headers:o,body:r,bodyBytes:a}=t;e(null,{status:s,statusCode:i,headers:o,body:r,bodyBytes:a},r,a)}),(t=>e(t&&t.error||"UndefinedError")));break;case"Node.js":let s=require("iconv-lite");this.initGotEnv(t),this.got(t).on("redirect",((t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();s&&this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}})).then((t=>{const{statusCode:i,statusCode:o,headers:r,rawBody:a}=t,n=s.decode(a,this.encoding);e(null,{status:i,statusCode:o,headers:r,rawBody:a,body:n},n)}),(t=>{const{message:i,response:o}=t;e(i,o,o&&s.decode(o.rawBody,this.encoding))}));break}}post(t,e=(()=>{})){const s=t.method?t.method.toLocaleLowerCase():"post";switch(t.body&&t.headers&&!t.headers["Content-Type"]&&!t.headers["content-type"]&&(t.headers["content-type"]="application/x-www-form-urlencoded"),t.headers&&(delete t.headers["Content-Length"],delete t.headers["content-length"]),void 0===t.followRedirect||t.followRedirect||((this.isSurge()||this.isLoon())&&(t["auto-redirect"]=!1),this.isQuanX()&&(t.opts?t.opts.redirection=!1:t.opts={redirection:!1})),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient[s](t,((t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,i)}));break;case"Quantumult X":t.method=s,this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then((t=>{const{statusCode:s,statusCode:i,headers:o,body:r,bodyBytes:a}=t;e(null,{status:s,statusCode:i,headers:o,body:r,bodyBytes:a},r,a)}),(t=>e(t&&t.error||"UndefinedError")));break;case"Node.js":let i=require("iconv-lite");this.initGotEnv(t);const{url:o,...r}=t;this.got[s](o,r).then((t=>{const{statusCode:s,statusCode:o,headers:r,rawBody:a}=t,n=i.decode(a,this.encoding);e(null,{status:s,statusCode:o,headers:r,rawBody:a,body:n},n)}),(t=>{const{message:s,response:o}=t;e(s,o,o&&i.decode(o.rawBody,this.encoding))}));break}}time(t,e=null){const s=e?new Date(e):new Date;let i={"M+":s.getMonth()+1,"d+":s.getDate(),"H+":s.getHours(),"m+":s.getMinutes(),"s+":s.getSeconds(),"q+":Math.floor((s.getMonth()+3)/3),S:s.getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,(s.getFullYear()+"").substr(4-RegExp.$1.length)));for(let e in i)new RegExp("("+e+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?i[e]:("00"+i[e]).substr((""+i[e]).length)));return t}queryStr(t){let e="";for(const s in t){let i=t[s];null!=i&&""!==i&&("object"==typeof i&&(i=JSON.stringify(i)),e+=`${s}=${i}&`)}return e=e.substring(0,e.length-1),e}msg(e=t,s="",i="",o={}){const r=t=>{const{$open:e,$copy:s,$media:i,$mediaMime:o}=t;switch(typeof t){case void 0:return t;case"string":switch(this.getEnv()){case"Surge":case"Stash":default:return{url:t};case"Loon":case"Shadowrocket":return t;case"Quantumult X":return{"open-url":t};case"Node.js":return}case"object":switch(this.getEnv()){case"Surge":case"Stash":case"Shadowrocket":default:{const r={};let a=t.openUrl||t.url||t["open-url"]||e;a&&Object.assign(r,{action:"open-url",url:a});let n=t["update-pasteboard"]||t.updatePasteboard||s;if(n&&Object.assign(r,{action:"clipboard",text:n}),i){let t,e,s;if(i.startsWith("http"))t=i;else if(i.startsWith("data:")){const[t]=i.split(";"),[,o]=i.split(",");e=o,s=t.replace("data:","")}else{e=i,s=(t=>{const e={JVBERi0:"application/pdf",R0lGODdh:"image/gif",R0lGODlh:"image/gif",iVBORw0KGgo:"image/png","/9j/":"image/jpg"};for(var s in e)if(0===t.indexOf(s))return e[s];return null})(i)}Object.assign(r,{"media-url":t,"media-base64":e,"media-base64-mime":o??s})}return Object.assign(r,{"auto-dismiss":t["auto-dismiss"],sound:t.sound}),r}case"Loon":{const s={};let o=t.openUrl||t.url||t["open-url"]||e;o&&Object.assign(s,{openUrl:o});let r=t.mediaUrl||t["media-url"];return i?.startsWith("http")&&(r=i),r&&Object.assign(s,{mediaUrl:r}),console.log(JSON.stringify(s)),s}case"Quantumult X":{const o={};let r=t["open-url"]||t.url||t.openUrl||e;r&&Object.assign(o,{"open-url":r});let a=t["media-url"]||t.mediaUrl;i?.startsWith("http")&&(a=i),a&&Object.assign(o,{"media-url":a});let n=t["update-pasteboard"]||t.updatePasteboard||s;return n&&Object.assign(o,{"update-pasteboard":n}),console.log(JSON.stringify(o)),o}case"Node.js":return}default:return}};if(!this.isMute)switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:$notification.post(e,s,i,r(o));break;case"Quantumult X":$notify(e,s,i,r(o));break;case"Node.js":break}if(!this.isMuteLog){let t=["","==============📣系统通知📣=============="];t.push(e),s&&t.push(s),i&&t.push(i),console.log(t.join("\n")),this.logs=this.logs.concat(t)}}debug(...t){this.logLevels[this.logLevel]<=this.logLevels.debug&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.debug}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}info(...t){this.logLevels[this.logLevel]<=this.logLevels.info&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.info}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}warn(...t){this.logLevels[this.logLevel]<=this.logLevels.warn&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.warn}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}error(...t){this.logLevels[this.logLevel]<=this.logLevels.error&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.error}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.map((t=>t??String(t))).join(this.logSeparator))}logErr(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:this.log("",`❗️${this.name}, 错误!`,e,t);break;case"Node.js":this.log("",`❗️${this.name}, 错误!`,e,void 0!==t.message?t.message:t,t.stack);break}}wait(t){return new Promise((e=>setTimeout(e,t)))}done(t={}){const e=((new Date).getTime()-this.startTime)/1e3;switch(this.log("",`🔔${this.name}, 结束! 🕛 ${e} 秒`),this.log(),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:$done(t);break;case"Node.js":process.exit(1)}}}(t,e)}
