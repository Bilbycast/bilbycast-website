// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://bilbycast.com',
	integrations: [
		starlight({
			title: 'Bilbycast',
			logo: {
				src: './src/assets/bilbycast-icon.png',
				alt: 'Bilbycast',
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Bilbycast' },
			],
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://bilbycast.com/og-image.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://bilbycast.com/og-image.png' } },
			],
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'getting-started' },
						{ label: 'Deployment', slug: 'getting-started/deployment' },
						{ label: 'Your First Flow', slug: 'getting-started/first-flow' },
					],
				},
				{
					label: 'Edge (Media Gateway)',
					items: [
						{ label: 'Overview', slug: 'edge/overview' },
						{ label: 'Supported Protocols', slug: 'edge/supported-protocols' },
						{ label: 'Configuration', slug: 'edge/configuration' },
						{ label: 'API Reference', slug: 'edge/api-reference' },
						{ label: 'Architecture', slug: 'edge/architecture' },
						{ label: 'Events & Alarms', slug: 'edge/events-and-alarms' },
						{ label: 'SMPTE ST 2110', slug: 'edge/st2110' },
						{ label: 'NMOS', slug: 'edge/nmos' },
						{ label: 'Audio Gateway', slug: 'edge/audio-gateway' },
						{ label: 'Setup Wizard', slug: 'edge/setup-wizard' },
						{ label: 'PTP Integration', slug: 'edge/ptp' },
						{ label: 'Manager Protocol', slug: 'edge/manager-protocol' },
					],
				},
				{
					label: 'Manager (Control Plane)',
					items: [
						{ label: 'Overview', slug: 'manager/overview' },
						{ label: 'API Reference', slug: 'manager/api-reference' },
						{ label: 'Security', slug: 'manager/security' },
						{ label: 'IP Tunneling', slug: 'manager/ip-tunneling' },
						{ label: 'Topology Visualization', slug: 'manager/topology' },
						{ label: 'AI Assistant', slug: 'manager/ai-assistant' },
						{ label: 'Device Drivers', slug: 'manager/device-drivers' },
						{ label: 'Config Reconciliation', slug: 'manager/config-reconciliation' },
						{ label: 'TLS Deployment', slug: 'manager/tls-deployment' },
					],
				},
				{
					label: 'Relay (NAT Traversal)',
					items: [
						{ label: 'Overview', slug: 'relay/overview' },
						{ label: 'Architecture', slug: 'relay/architecture' },
						{ label: 'Security & Authentication', slug: 'relay/security' },
						{ label: 'Stats Reference', slug: 'relay/stats-reference' },
						{ label: 'Events & Alarms', slug: 'relay/events-and-alarms' },
					],
				},
				{
					label: 'SRT Library',
					items: [
						{ label: 'Overview', slug: 'srt/overview' },
						{ label: 'Usage Guide', slug: 'srt/usage' },
						{ label: 'libsrt Comparison', slug: 'srt/libsrt-comparison' },
					],
				},
				{
					label: 'Appear X Gateway',
					items: [
						{ label: 'Overview', slug: 'appear-x-gateway/overview' },
						{ label: 'Setup Guide', slug: 'appear-x-gateway/setup-guide' },
						{ label: 'Architecture', slug: 'appear-x-gateway/architecture' },
						{ label: 'Adding New Device Gateways', slug: 'appear-x-gateway/adding-new-device-gateways' },
					],
				},
				{
					label: 'Security',
					autogenerate: { directory: 'security' },
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
