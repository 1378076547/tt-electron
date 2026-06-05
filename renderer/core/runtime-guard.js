/**
 * TT 页面操作互斥（阶段 0）
 * @typedef {{ busy?: boolean, pmPullInProgress?: boolean, priorityBatchInProgress?: boolean, titleNormalizeInProgress?: boolean, running?: boolean, batchInProgress?: boolean }} GuardState
 */
(function initGuard(TD) {
  function isWebviewOpLocked(s) {
    return !!(s.busy || s.pmPullInProgress || s.priorityBatchInProgress || s.titleNormalizeInProgress);
  }

  TD.guard = {
    isWebviewOpLocked,

    canRunCheck(s) {
      return !isWebviewOpLocked(s);
    },

    canStartPmPull(s) {
      if (s.pmPullInProgress) return false;
      if (s.busy) return false;
      if (s.priorityBatchInProgress) return false;
      if (s.titleNormalizeInProgress) return false;
      return true;
    },

    canStartPriorityBatch(s) {
      if (s.priorityBatchInProgress) return false;
      if (s.titleNormalizeInProgress) return false;
      if (s.pmPullInProgress) return false;
      return true;
    },

    canStartTitleNormalize(s) {
      if (s.titleNormalizeInProgress) return false;
      if (s.priorityBatchInProgress) return false;
      if (s.pmPullInProgress) return false;
      return true;
    },

    canRefreshDuringPm(s) {
      return !s.pmPullInProgress;
    },

    msgPmBlocked() {
      return "正在批量设置优先级，请稍后再试「按地区拉PM」。";
    },

    msgPriorityBlockedByPm() {
      return "正在按地区拉 PM，请稍后再试批量设置优先级。";
    },

    msgTitleNormalizeBlocked() {
      return "请等待「标题检测」完成后再试。";
    },

    msgPmBlockedByBusy() {
      return "自动处理正在执行脚本，请等待本轮结束后再试「按地区拉PM」。";
    }
  };
})(window.TTDesktop);
