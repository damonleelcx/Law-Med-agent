import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { IconArrowL, LogoMark } from '../../components/Icons'
import LangSwitch from '../../components/LangSwitch'
import { icp, icpLicence, region, useI18n } from '../../lib/i18n'
import { privacy, terms } from './content'
import { cnPrivacy, cnTerms } from './content.cn'
import '../../styles/legal.css'

// The mainland China copy has its own documents, in Chinese only, naming only
// the mainland providers it uses (content.cn.ts).
const cn = region === 'cn'

export default function Legal({ kind }: { kind: 'terms' | 'privacy' }) {
  const { lang: uiLang, t } = useI18n()
  const lang = cn ? 'zh' : uiLang
  const pick = (k: 'terms' | 'privacy') => (cn ? (k === 'terms' ? cnTerms : cnPrivacy) : (k === 'terms' ? terms : privacy)[lang])
  const doc = pick(kind)
  const other = kind === 'terms' ? { to: '/privacy', label: pick('privacy').title } : { to: '/terms', label: pick('terms').title }
  useEffect(() => {
    document.title = `${doc.title} · ACT`
    window.scrollTo(0, 0)
  }, [doc.title])
  return (
    <div className="legal">
      <header className="legal-top">
        <Link to="/" className="legal-logo"><LogoMark /><span>ACT</span></Link>
        {!cn && <LangSwitch />}
      </header>
      <main className="legal-body">
        <Link to="/" className="legal-back"><IconArrowL size={16} /> {lang === 'zh' ? '返回首页' : 'Back to home'}</Link>
        <h1>{doc.title}</h1>
        <p className="legal-updated">{doc.updated}</p>
        <p className="legal-intro">{doc.intro}</p>
        <nav className="legal-toc" aria-label={lang === 'zh' ? '目录' : 'Contents'}>
          {doc.sections.map((s, i) => <a key={s.h} href={`#s${i}`}>{s.h}</a>)}
        </nav>
        {doc.sections.map((s, i) => (
          <section key={s.h} id={`s${i}`}>
            <h2>{s.h}</h2>
            {s.p.map((para, j) => <p key={j}>{para}</p>)}
          </section>
        ))}
        <footer className="legal-foot">
          <Link to={other.to}>{other.label} →</Link>
          <p>{cn ? "ACT 提供信息与协助。在持证专业人士审阅之前，本站内容均不构成法律或医疗意见。紧急情况请拨打 120。" : t.footer.disclaimer}</p>
          {icp && <p><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{icp}</a></p>}
          {icpLicence && <p>增值电信业务经营许可证：{icpLicence}</p>}
        </footer>
      </main>
    </div>
  )
}
