import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Briefcase,
  MessageCircle,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";

interface ImChannelStatus {
  id: string;
  name: string;
  icon: string;
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  online: boolean;
}

function ChannelIcon({ icon }: { icon: string }) {
  if (icon === "message-square") {
    return <MessageSquare className="h-5 w-5" />;
  }
  if (icon === "briefcase") {
    return <Briefcase className="h-5 w-5" />;
  }
  if (icon === "message-circle") {
    return <MessageCircle className="h-5 w-5" />;
  }
  return <Radio className="h-5 w-5" />;
}

export function IMChannelsPanel() {
  const [channels, setChannels] = useState<ImChannelStatus[]>([]);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadChannels = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    setLoading(true);
    invoke<ImChannelStatus[]>("list_im_channels")
      .then((result) => {
        if (!mountedRef.current) {
          return;
        }
        setChannels(result);
      })
      .catch((error) => {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return;
        }
        setMessage(`加载渠道失败：${String(error)}`);
        setChannels([]);
      })
      .finally(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const callAction = (command: string, channelId: string) => {
    if (!mountedRef.current || loading || workingId) {
      return;
    }

    setWorkingId(channelId);
    setMessage("");

    invoke<string>(command, { channelId })
      .then((result) => {
        if (!mountedRef.current) {
          return;
        }
        setMessage(result);
        loadChannels();
      })
      .catch((error) => {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return;
        }
        setMessage(`操作失败：${String(error)}`);
      })
      .finally(() => {
        if (mountedRef.current) {
          setWorkingId(null);
        }
      });
  };

  const addChannel = () => {
    if (loading || workingId) {
      return;
    }
    const channelInput = window.prompt("请输入渠道名称（飞书 / 企业微信 / QQ）", "飞书");
    if (!channelInput) {
      return;
    }
    const normalized = channelInput.trim().toLowerCase();
    const channelId =
      normalized === "飞书" || normalized === "feishu"
        ? "feishu"
        : normalized === "企业微信" || normalized === "wecom"
        ? "wecom"
        : normalized === "qq"
        ? "qq"
        : normalized;
    callAction("pair_im_channel", channelId);
  };

  return (
    <section className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-100">IM 渠道</h2>
          <p className="text-sm text-neutral-400">仅在手动刷新或操作后更新，彻底移除自动轮询。</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-700"
            onClick={loadChannels}
            disabled={loading || Boolean(workingId)}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <Button
            onClick={addChannel}
            className="bg-orange-500 text-white hover:bg-orange-400"
            disabled={loading || Boolean(workingId)}
          >
            <Plus className="mr-2 h-4 w-4" />
            添加渠道
          </Button>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {channels.map((channel) => {
          const busy = workingId === channel.id;
          const statusText = channel.online ? "在线" : channel.connected ? "离线" : "未接入";

          return (
            <article
              key={channel.id}
              className="rounded-xl border border-neutral-800 bg-neutral-800 p-4"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 text-neutral-100">
                  <span className="rounded-lg bg-neutral-900 p-2 text-orange-400">
                    <ChannelIcon icon={channel.icon} />
                  </span>
                  <div>
                    <h3 className="font-semibold">{channel.name}</h3>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs ${
                    channel.online
                      ? "bg-green-500/15 text-green-300"
                      : "bg-neutral-700 text-neutral-300"
                  }`}
                >
                  {statusText}
                </span>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2 text-xs text-neutral-400">
                <div className="rounded bg-neutral-900 px-2 py-1">
                  已配置: {channel.configured ? "是" : "否"}
                </div>
                <div className="rounded bg-neutral-900 px-2 py-1">
                  已启用: {channel.enabled ? "是" : "否"}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-700"
                  onClick={() => callAction("pair_im_channel", channel.id)}
                  disabled={busy || loading}
                >
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                  配对管理
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-orange-500/60 bg-neutral-900 text-orange-400 hover:bg-orange-500/10"
                  onClick={() => callAction("disable_im_channel", channel.id)}
                  disabled={busy || loading}
                >
                  <Unplug className="mr-1 h-3.5 w-3.5" />
                  禁用
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="bg-red-600 text-white hover:bg-red-500"
                  onClick={() => callAction("delete_im_channel", channel.id)}
                  disabled={busy || loading}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      {message ? <p className="text-sm text-neutral-300">{message}</p> : null}
    </section>
  );
}
