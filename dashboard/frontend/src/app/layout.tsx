import type { Metadata } from "next";
import { Inter, Outfit } from "next/font/google";
import { AuthProvider } from "@/context/AuthContext";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Crest Meet — Turn every meeting into searchable knowledge",
  description:
    "Crest Meet deploys AI bots to Google Meet, Zoom, and Teams to transcribe, summarize, and let you chat across all your meetings.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${outfit.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="font-sans min-h-full flex flex-col bg-bg text-ink">
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
