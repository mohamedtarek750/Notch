import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Notch — Taking education up a notch",
  description:
    "Taking education up a notch. A bilingual, evidence-led adaptive learning platform.",
  icons: { icon: "/brand/notch-mark.png" },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
