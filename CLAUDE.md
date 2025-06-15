# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run build         # Build TypeScript to JavaScript
npm run watch         # Build, link locally, and watch for changes
npm run lint          # Run ESLint on src/**/*.ts
npm run test          # Run Jest tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

### Testing Individual Tests
```bash
npm test -- --testNamePattern="test name"  # Run tests matching name
npm test path/to/test.ts                   # Run specific test file
```

## Architecture

This is a Homebridge plugin that bridges VeSync smart home devices to Apple HomeKit. The codebase follows an object-oriented architecture with these key patterns:

### Core Components

1. **TSVESyncPlatform** (`src/platform.ts`): Main platform class implementing Homebridge's DynamicPlatformPlugin. Handles device discovery, authentication, and lifecycle management.

2. **BaseAccessory** (`src/accessories/base.accessory.ts`): Abstract base class that all device accessories extend. Provides common functionality like state management, API interactions, and HomeKit service setup.

3. **DeviceFactory** (`src/utils/device-factory.ts`): Factory pattern implementation that creates appropriate accessory instances based on device type and model.

4. **API Proxy** (`src/utils/api-proxy.ts`): Implements rate limiting and quota management for VeSync API calls to prevent hitting daily limits.

### Key Patterns

- **Inheritance**: All device accessories (air purifiers, humidifiers, outlets, etc.) extend BaseAccessory
- **Factory Pattern**: DeviceFactory dynamically creates accessory instances based on device type
- **Proxy Pattern**: API calls go through api-proxy for rate limiting and quota management
- **Retry Pattern**: RetryManager handles failed operations with exponential backoff

### Device Support

The plugin supports 40+ VeSync device models across categories:
- Air Purifiers (Levoit Core/Vital series)
- Humidifiers (Levoit Classic/LV600 series)
- Smart Outlets (Etekcity)
- Smart Switches
- Smart Bulbs
- Tower Fans

Each device type has its own accessory class in `src/accessories/` that maps device-specific features to appropriate HomeKit characteristics.

### API Integration

The plugin uses the unofficial `tsvesync` library to communicate with VeSync's API. Key considerations:
- API has daily quota limits (handled by QuotaManager)
- Requests are rate-limited to prevent throttling
- Failed requests are retried with exponential backoff
- Device state is cached to minimize API calls