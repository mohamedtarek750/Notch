import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Tilwa | تِلوا — اعرف طريقك",
  description: "Know your path. A bilingual, evidence-led learning workspace.",
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
