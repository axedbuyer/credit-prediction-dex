import { DocsSidebar } from './DocsSidebar'

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-6xl gap-12 px-6 py-10 lg:px-10">
      <DocsSidebar />
      <div className="min-w-0 flex-1">
        <div className="docs-prose max-w-[760px]">{children}</div>
      </div>
    </div>
  )
}
