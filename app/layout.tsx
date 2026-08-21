import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "./lib/store";

export const metadata: Metadata = {
  title: "合订本",
  description: "小红书 / B站 收藏沉淀",
  icons: { icon: '/icon.svg' },
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
