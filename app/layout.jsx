import "./globals.css";

export const metadata = {
  title: "KasCoven Vaults",
  description: "Time-locked covenant vaults on the Kaspa blockDAG.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
