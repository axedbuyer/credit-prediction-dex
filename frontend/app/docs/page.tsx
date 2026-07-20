import { redirect } from 'next/navigation'
import { docHref } from './nav'

export default function DocsIndexPage() {
  redirect(docHref('what-is-pari'))
}
