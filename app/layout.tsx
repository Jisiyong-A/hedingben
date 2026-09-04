import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "./lib/store";

export const metadata: Metadata = {
  title: "合订本",
  description: "小红书 / B站 收藏沉淀",
  icons: { icon: '/icon.svg' },
};

// viewport-fit=cover：iOS 刘海屏/灵动岛下内容延伸到安全区外沿，
// env(safe-area-inset-*) 才有非零值（组件层通过 --inset-* 消费）。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <AppProvider>
          {children}
        </AppProvider>
      </body>
    </html>
  );
}
