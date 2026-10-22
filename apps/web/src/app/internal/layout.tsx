// Material Symbols is only used under this route; kept out of the root layout so the landing page doesn't load it.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
        precedence="default"
      />
      {children}
    </>
  )
}
