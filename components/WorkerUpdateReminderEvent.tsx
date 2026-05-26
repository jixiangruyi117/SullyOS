/**
 * WorkerUpdateReminderEvent.tsx
 * 后端 (Instant Push Worker) 更新提醒弹窗。
 *
 * 背景：用户的 worker 跑在自己的 Cloudflare 账户里，目前没法保证自动跟上游同步
 * (见 worker/instant-push/README.md 阶段 2 第 5 条存疑说明)。所以每次我们更新
 * worker 代码就 bump 下面的 WORKER_BUILD_VERSION，启用了 Instant Push 的用户会被
 * 提醒一次：去重新部署 / 同步一下 worker，确认后记下版本，不再反复弹。
 *
 * 只提醒启用了 Instant Push 的用户；没开的人完全不受打扰。
 */

import React from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { loadInstantConfig } from '../utils/instantPushClient';
import { FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_05_27 } from './UpdateNotificationEvent';

// 每次更新 worker 代码就 bump 这个值 (用日期最直观)。
export const WORKER_BUILD_VERSION = '2026-05-26';

// 记录用户「已确认过的 worker 版本号」。
const WORKER_UPDATE_SEEN_KEY = 'sullyos_worker_build_seen';

/**
 * 把当前 worker 版本标记为已确认。用户点过提醒、或刚配好 worker (视为已是最新)
 * 时调用，避免之后被无意义地反复提醒。
 */
export const markWorkerBuildSeen = (): void => {
  try {
    localStorage.setItem(WORKER_UPDATE_SEEN_KEY, WORKER_BUILD_VERSION);
  } catch { /* ignore */ }
};

/**
 * 是否要弹「worker 有更新」提醒：
 *  - 只对启用了 Instant Push 的用户弹
 *  - 已确认版本与当前内置版本不一致才弹 (null 也算不一致 —— 老用户首次铺该功能时提醒一次)
 */
export const shouldShowWorkerUpdateReminder = (): boolean => {
  try {
    const cfg = loadInstantConfig();
    if (!cfg.enabled) return false;
    const seen = localStorage.getItem(WORKER_UPDATE_SEEN_KEY);
    return seen !== WORKER_BUILD_VERSION;
  } catch {
    return false;
  }
};

interface WorkerUpdateReminderPopupProps {
  onClose: () => void;
}

export const WorkerUpdateReminderPopup: React.FC<WorkerUpdateReminderPopupProps> = ({ onClose }) => {
  const { openApp } = useOS();

  const handleViewHelp = () => {
    markWorkerBuildSeen();
    try {
      sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_05_27);
    } catch { /* ignore */ }
    openApp(AppID.FAQ);
    onClose();
  };

  const handleDismiss = () => {
    markWorkerBuildSeen();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
      <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
        <div className="pt-7 pb-3 px-6 text-center">
          <img
            src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6e0.png"
            alt="worker update"
            className="w-10 h-10 mx-auto mb-2"
          />
          <h2 className="text-lg font-extrabold text-slate-800">Worker 有更新</h2>
          <p className="text-[11px] text-slate-400 mt-1">Instant Push · 建议同步一下你的 Worker</p>
        </div>

        <div className="px-6 pb-4 space-y-3">
          <div className="bg-gradient-to-br from-indigo-50 to-sky-50 border border-indigo-100 rounded-2xl p-4">
            <p className="text-[13px] text-slate-700 leading-relaxed">
              我们更新了 <strong className="text-indigo-600">Instant Push 的后端 Worker 代码</strong>。
              由于 Worker 跑在<strong>你自己的 Cloudflare 账户</strong>里，
              <strong className="text-rose-600">不会自动跟着我们更新</strong>，
              需要你手动同步一次才能用上最新版本。
            </p>
            <p className="text-[12px] text-slate-500 leading-relaxed mt-2">
              不更新通常也能继续用，只是可能缺少新功能或修复。更新方式：到
              <strong> worker 目录的 README</strong> 按「备用方案」重新粘贴一次
              <strong> worker.bundle.js</strong>，或重新克隆部署。
            </p>
          </div>
        </div>

        <div className="px-6 pb-7 pt-2 space-y-2">
          <button
            onClick={handleViewHelp}
            className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-sky-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 active:scale-95 transition-transform text-sm"
          >
            去看怎么更新
          </button>
          <button
            onClick={handleDismiss}
            className="w-full py-2.5 text-slate-400 font-medium text-[12px]"
          >
            知道了，先不更新
          </button>
        </div>
      </div>
    </div>
  );
};

interface WorkerUpdateReminderControllerProps {
  onClose: () => void;
}

export const WorkerUpdateReminderController: React.FC<WorkerUpdateReminderControllerProps> = ({ onClose }) => {
  return <WorkerUpdateReminderPopup onClose={onClose} />;
};
