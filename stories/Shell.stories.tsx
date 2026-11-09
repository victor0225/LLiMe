import type { Meta, StoryObj } from '@storybook/react-vite';
import { App } from '../web/app';

const meta = { title: 'Shell/App', component: App } satisfies Meta<typeof App>;
export default meta;

export const Waiting: StoryObj<typeof meta> = {};
