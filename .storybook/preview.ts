import type { Preview } from '@storybook/react-vite';
import '../web/styles/tokens.css';
import '../web/styles/components.css';

const preview: Preview = {
  parameters: { layout: 'fullscreen' },
};

export default preview;
