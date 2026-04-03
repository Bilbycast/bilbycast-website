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
					],
				},
				{
					label: 'Manager (Control Plane)',
					items: [
						{ label: 'Overview', slug: 'manager/overview' },
						{ label: 'API Reference', slug: 'manager/api-reference' },
						{ label: 'Security', slug: 'manager/security' },
						{ label: 'IP Tunneling', slug: 'manager/ip-tunneling' },
					],
				},
				{
					label: 'Relay (NAT Traversal)',
					items: [
						{ label: 'Overview', slug: 'relay/overview' },
						{ label: 'Architecture', slug: 'relay/architecture' },
						{ label: 'Events & Alarms', slug: 'relay/events-and-alarms' },
					],
				},
				{
					label: 'SRT Library (Pure Rust)',
					items: [
						{ label: 'Overview', slug: 'srt/overview' },
						{ label: 'libsrt Comparison', slug: 'srt/libsrt-comparison' },
					],
				},
				{
					label: 'Appear X Gateway',
					items: [
						{ label: 'Overview', slug: 'appear-x-gateway/overview' },
						{ label: 'Setup Guide', slug: 'appear-x-gateway/setup-guide' },
						{ label: 'Architecture', slug: 'appear-x-gateway/architecture' },
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
