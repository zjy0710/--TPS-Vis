import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TPS-Vis | PD-L1 Expression Explorer",
  description:
    "Interactive multi-scale visual analysis of PD-L1 expression in lung cancer pathology images.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
