#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/index.tsx';
import { initTelemetry } from './agent/telemetry.ts';

initTelemetry();

render(React.createElement(App));
