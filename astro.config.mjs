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
						{ label: 'Deployment Overview', slug: 'getting-started/deployment' },
						{ label: 'Your First Flow', slug: 'getting-started/first-flow' },
						{ label: 'Build from Source', slug: 'getting-started/build-from-source' },
					],
				},
				{
					label: 'Edge (Media Gateway)',
					items: [
						{ label: 'Overview', slug: 'edge/overview' },
						{ label: 'Install an Edge Node', slug: 'edge/getting-started' },
						{ label: 'Install as a Linux Service', slug: 'edge/install-ubuntu-service' },
						{ label: 'Setup Wizard', slug: 'edge/setup-wizard' },
						{ label: 'Supported Protocols', slug: 'edge/supported-protocols' },
						{ label: 'Configuration', slug: 'edge/configuration' },
						{ label: 'Display Output', slug: 'edge/display' },
						{ label: 'Multiviewer (Mosaic Wall)', slug: 'edge/multiviewer' },
						{ label: 'Replay (Recording + Clips)', slug: 'edge/replay' },
						{ label: 'Flow Assembly (PID Bus)', slug: 'edge/flow-assembly' },
						{ label: 'Multi-Path Bonding', slug: 'edge/bonding' },
						{ label: 'Bonding Network Setup', slug: 'edge/bonding-network-setup' },
						{ label: 'Cellular Modem Bonding Path', slug: 'edge/bonding-cellular-modem' },
						{ label: 'Cellular Uplink Telemetry', slug: 'edge/cellular' },
						{ label: 'Starlink Dish Telemetry', slug: 'edge/starlink' },
						{ label: 'API Reference', slug: 'edge/api-reference' },
						{ label: 'Architecture', slug: 'edge/architecture' },
						{ label: 'Events & Alarms', slug: 'edge/events-and-alarms' },
						{ label: 'SMPTE ST 2110', slug: 'edge/st2110' },
						{ label: 'MXL (Media eXchange Layer)', slug: 'edge/mxl' },
						{ label: 'SDI (Blackmagic DeckLink)', slug: 'edge/sdi' },
						{ label: 'NMOS', slug: 'edge/nmos' },
						{ label: 'Audio Gateway', slug: 'edge/audio-gateway' },
						{ label: 'Time (PTP)', slug: 'edge/ptp' },
						{ label: 'Master Clock & A/V Sync', slug: 'edge/clocking' },
						{ label: 'Wire-Time Precision', slug: 'edge/wire-pacing' },
						{ label: 'Codec Matrix', slug: 'edge/codec-matrix' },
						{ label: 'Resources & Capacity', slug: 'edge/resources' },
						{ label: 'Manager Protocol', slug: 'edge/manager-protocol' },
					],
				},
				{
					label: 'Manager (Control Plane)',
					items: [
						{ label: 'Overview', slug: 'manager/overview' },
						{ label: 'Install the Manager', slug: 'manager/getting-started' },
						{ label: 'Live Switcher', slug: 'manager/switcher' },
						{ label: 'Node Bus Matrix', slug: 'manager/node-bus' },
						{ label: 'Multiviewer Walls', slug: 'manager/multiviewer' },
						{ label: 'Visual Flow Editor', slug: 'manager/visual-flow-editor' },
						{ label: 'Address Pools', slug: 'manager/address-pools' },
						{ label: 'Aligned Output (Cross-Node)', slug: 'manager/aligned-output' },
						{ label: 'Replay (Operator UI)', slug: 'manager/replay' },
						{ label: 'Routines', slug: 'manager/routines' },
						{ label: 'Multi-tenant Groups', slug: 'manager/multi-tenant-groups' },
						{ label: 'Media Library', slug: 'manager/media-library' },
						{ label: 'AI Assistant', slug: 'manager/ai-assistant' },
						{ label: 'Topology Visualization', slug: 'manager/topology' },
						{ label: 'Device Drivers', slug: 'manager/device-drivers' },
						{ label: 'Config Reconciliation', slug: 'manager/config-reconciliation' },
						{ label: 'Remote Upgrade', slug: 'manager/remote-upgrade' },
						{ label: 'Encrypted Backup & Restore', slug: 'manager/backup' },
						{ label: 'Active/Active HA', slug: 'manager/active-active-ha' },
						{ label: 'Security', slug: 'manager/security' },
						{ label: 'TLS Deployment', slug: 'manager/tls-deployment' },
						{ label: 'IP Tunneling', slug: 'manager/ip-tunneling' },
						{ label: 'API Reference', slug: 'manager/api-reference' },
					],
				},
				{
					label: 'Relay (NAT Traversal)',
					items: [
						{ label: 'Overview', slug: 'relay/overview' },
						{ label: 'Install the Relay', slug: 'relay/getting-started' },
						{ label: 'Viewer Distribution (WHEP + LL-HLS)', slug: 'relay/viewer-distribution' },
						{ label: 'Architecture', slug: 'relay/architecture' },
						{ label: 'Security & Authentication', slug: 'relay/security' },
						{ label: 'API Reference', slug: 'relay/api-reference' },
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
					label: 'RIST Library',
					items: [
						{ label: 'Overview', slug: 'rist/overview' },
						{ label: 'Usage Guide', slug: 'rist/usage' },
						{ label: 'Protocol Reference', slug: 'rist/protocol-reference' },
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
				// Starlight 0.39 removed support for an `autogenerate` object
				// carrying its own `label`; a labelled group now has to wrap
				// the autogenerate config in `items`. Same rendered sidebar.
				{
					label: 'Security',
					items: [{ autogenerate: { directory: 'security' } }],
				},
				{
					label: 'Reference',
					items: [{ autogenerate: { directory: 'reference' } }],
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
