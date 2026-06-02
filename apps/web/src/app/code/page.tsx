import { HeroSection } from './components/hero'
import { FeaturesSection } from './components/features'
import { ModelsSection } from './components/models'
import { InstallSection } from './components/install-cmd'
import { FooterSection } from './components/footer'

export default function CodePage() {
  return (
    <div className="min-h-screen">
      <HeroSection />
      <FeaturesSection />
      <ModelsSection />
      <InstallSection />
      <FooterSection />
    </div>
  )
}
