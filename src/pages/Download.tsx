/**
 * 下载页：为其它设备获取官方 LocalSend 客户端的官网渠道，并说明本插件的
 * 定位——兼容 LocalSend 协议 v2 的开源实现，Windows 电脑端无需再装官方桌面版。
 * 链接经宿主 openExternal 用系统浏览器打开；浏览器直跑回落 window.open。
 */

import { openExternal } from "otools-plugin-sdk/runtime";

const LINKS = {
  site: "https://localsend.org",
  releases: "https://github.com/localsend/localsend/releases/latest",
  protocol: "https://github.com/localsend/protocol",
  repo: "https://github.com/ootools/otools-localsend",
  androidPlay: "https://play.google.com/store/apps/details?id=org.localsend.app",
  androidFdroid: "https://f-droid.org/packages/org.localsend.app/",
  iosAppStore: "https://apps.apple.com/app/localsend/id1661734711",
  linuxFlathub: "https://flathub.org/apps/org.localsend.localsend_app",
};

function openLink(url: string) {
  if (!openExternal(url) && typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
  }
}

interface Channel {
  id: string;
  icon: string;
  name: string;
  note: string;
  links: Array<{ label: string; url: string }>;
}

const CHANNELS: Channel[] = [
  {
    id: "android",
    icon: "🤖",
    name: "Android",
    note: "Google Play、F-Droid 或官网 APK",
    links: [
      { label: "Google Play", url: LINKS.androidPlay },
      { label: "F-Droid", url: LINKS.androidFdroid },
      { label: "官网", url: LINKS.site },
    ],
  },
  {
    id: "ios",
    icon: "🍎",
    name: "iPhone / iPad",
    note: "App Store 搜索 LocalSend",
    links: [
      { label: "App Store", url: LINKS.iosAppStore },
      { label: "官网", url: LINKS.site },
    ],
  },
  {
    id: "macos",
    icon: "💻",
    name: "macOS",
    note: "官网 dmg 或 Homebrew",
    links: [
      { label: "官网下载", url: LINKS.site },
      { label: "GitHub Releases", url: LINKS.releases },
    ],
  },
  {
    id: "linux",
    icon: "🐧",
    name: "Linux",
    note: "Flathub、AppImage、deb 均可",
    links: [
      { label: "Flathub", url: LINKS.linuxFlathub },
      { label: "官网下载", url: LINKS.site },
    ],
  },
  {
    id: "windows",
    icon: "🖥️",
    name: "Windows",
    note: "本插件即 Windows 电脑端，无需重复安装；如需独立官方客户端可从官网获取",
    links: [
      { label: "官网下载", url: LINKS.site },
      { label: "GitHub Releases", url: LINKS.releases },
    ],
  },
];

export function DownloadPage() {
  return (
    <div className="settings">
      <section className="card set-card">
        <h3>本插件即电脑端</h3>
        <p className="compat-note">
          本插件是<b>兼容 LocalSend 协议 v2 的开源实现</b>（GPL-3.0），在 OTools
          内提供完整的设备发现与文件/文本收发能力。<b>Windows 电脑无需再安装官方
          LocalSend 桌面版</b>——手机、平板等其它设备安装官方客户端后，与本插件处于
          同一局域网即可互相发现、互传。
        </p>
        <div className="dl-links" style={{ marginTop: 12 }}>
          <button type="button" className="link-chip" onClick={() => openLink(LINKS.site)}>
            🌐 LocalSend 官网
          </button>
          <button type="button" className="link-chip" onClick={() => openLink(LINKS.protocol)}>
            📜 协议规范（v2.2）
          </button>
          <button type="button" className="link-chip" onClick={() => openLink(LINKS.repo)}>
            🧩 本插件源码
          </button>
        </div>
      </section>

      <div className="dl-grid">
        {CHANNELS.map((channel) => (
          <section key={channel.id} className="card set-card">
            <div className="dl-head">
              <span className="tile" aria-hidden>{channel.icon}</span>
              <span className="dev-name">
                <b>{channel.name}</b>
                <small>{channel.note}</small>
              </span>
            </div>
            <div className="dl-links">
              {channel.links.map((link) => (
                <button
                  key={link.url}
                  type="button"
                  className="link-chip"
                  onClick={() => openLink(link.url)}
                >
                  {link.label} ↗
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
