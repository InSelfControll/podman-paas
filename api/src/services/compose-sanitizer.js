/**
 * Docker to Podman Compose Sanitizer
 * 
 * Converts Docker-specific compose configurations to Podman-compatible ones.
 * Handles: commands, volumes, environment variables, and Docker API dependencies.
 */

const PODMAN_SOCKET = process.env.PODMAN_SOCKET || '/run/user/1000/podman/podman.sock';

/**
 * Main sanitization function
 */
export function sanitizeComposeForPodman(content) {
  if (!content) return content;
  
  let sanitized = content;
  const changes = [];

  // Parse YAML to properly manipulate it
  try {
    const lines = content.split('\n');
    const result = [];
    let inService = false;
    let currentService = null;
    let indent = 0;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const originalLine = line;

      // Track service context
      if (line.match(/^\s{2}[a-zA-Z0-9_-]+:\s*$/)) {
        inService = true;
        currentService = line.trim().replace(':', '');
      }
      if (line.match(/^\s{2}[a-zA-Z_]+:/) && !line.match(/^\s{2}[a-zA-Z0-9_-]+:\s*$/)) {
        inService = false;
        currentService = null;
      }

      // 1. Fix Docker socket volume mounts
      if (line.includes('/var/run/docker.sock') || line.includes('/var/run/podman/podman.sock')) {
        line = line.replace(/\/var\/run\/docker\.sock/g, PODMAN_SOCKET);
        line = line.replace(/\/var\/run\/podman\/podman\.sock/g, PODMAN_SOCKET);
        changes.push(`Fixed Docker socket path: ${originalLine.trim()}`);
      }

      // 2. Remove Docker Swarm-specific options
      if (line.match(/^\s+deploy:/) && inService) {
        // Check if this is a Swarm mode deploy config
        const nextLines = lines.slice(i + 1, i + 10);
        const isSwarm = nextLines.some(l => 
          l.includes('replicas:') || 
          l.includes('placement:') || 
          l.includes('constraints:') ||
          l.includes('mode:') && l.includes('replicated')
        );
        if (isSwarm) {
          // Skip this section (Swarm-specific)
          let braceCount = 0;
          let j = i;
          while (j < lines.length) {
            if (lines[j].includes('{')) braceCount++;
            if (lines[j].includes('}')) braceCount--;
            if (braceCount === 0 && lines[j].trim() && !lines[j].match(/^\s+deploy:/)) {
              const indent = lines[j].match(/^(\s*)/)[1].length;
              if (indent <= 2) break;
            }
            j++;
          }
          changes.push(`Removed Swarm deploy config for ${currentService}`);
          i = j - 1;
          continue;
        }
      }

      // 3. Remove Docker-specific options that Podman doesn't support
      if (line.match(/^\s+runtime:\s*nvidia/)) {
        changes.push(`Removed nvidia runtime (use --device instead)`);
        continue; // Skip this line
      }

      if (line.match(/^\s+cgroup:/) || line.match(/^\s+cgroup_parent:/)) {
        changes.push(`Removed cgroup option`);
        continue;
      }

      // 4. Fix environment variables that reference Docker
      if (line.includes('DOCKER_')) {
        // DOCKER_HOST, DOCKER_SOCK, etc.
        if (line.includes('DOCKER_HOST')) {
          line = line.replace(/DOCKER_HOST=.*/, `DOCKER_HOST=unix://${PODMAN_SOCKET}`);
          changes.push(`Fixed DOCKER_HOST env var`);
        }
        if (line.includes('DOCKER_SOCK')) {
          line = line.replace(/\/var\/run\/docker\.sock/g, PODMAN_SOCKET);
          changes.push(`Fixed DOCKER_SOCK path`);
        }
      }

      // 5. Convert Docker commands in entrypoints/cmd
      if ((line.match(/^\s+command:/) || line.match(/^\s+entrypoint:/))) {
        const nextLine = lines[i + 1];
        if (nextLine && (nextLine.includes('docker') || nextLine.includes('docker-compose'))) {
          // Multi-line command - need to convert
          let cmdLines = [];
          let j = i + 1;
          while (j < lines.length && lines[j].match(/^\s+-/)) {
            cmdLines.push(lines[j]);
            j++;
          }
          const converted = convertDockerCommand(cmdLines.join('\n'));
          if (converted !== cmdLines.join('\n')) {
            line = line; // Keep the key
            result.push(line);
            result.push(...converted.split('\n'));
            changes.push(`Converted Docker command to Podman for ${currentService}`);
            i = j - 1;
            continue;
          }
        } else if (line.includes('docker') || line.includes('docker-compose')) {
          // Single line command
          line = convertDockerCommand(line);
          changes.push(`Converted Docker command to Podman`);
        }
      }

      // 6. Fix healthcheck with Docker-specific options
      if (line.match(/^\s+healthcheck:/)) {
        // Check for Docker-specific healthcheck options in subsequent lines
        let j = i + 1;
        while (j < lines.length && lines[j].match(/^\s{4,}/)) {
          if (lines[j].includes('start_period:') || lines[j].includes('start_interval:')) {
            // Podman supports start_period but not start_interval
            if (lines[j].includes('start_interval:')) {
              changes.push(`Removed unsupported start_interval from healthcheck`);
              j++;
              continue;
            }
          }
          result.push(lines[j]);
          j++;
        }
        result.push(line);
        i = j - 1;
        continue;
      }

      // 7. Remove depends_on with condition (Docker Compose v3+ swarm)
      if (line.match(/^\s+depends_on:/) && inService) {
        // Check if it's a complex depends_on with conditions
        const nextLines = lines.slice(i + 1, i + 5);
        const hasCondition = nextLines.some(l => l.includes('condition:'));
        if (hasCondition) {
          // Simplify to just service names
          changes.push(`Simplified depends_on (removed conditions)`);
          let j = i + 1;
          const simpleDepends = [];
          while (j < lines.length && lines[j].match(/^\s{4,}/)) {
            const match = lines[j].match(/^\s+-?\s*([a-zA-Z0-9_-]+):?/);
            if (match) {
              simpleDepends.push(`      - ${match[1]}`);
            }
            j++;
          }
          result.push(line);
          result.push(...simpleDepends);
          i = j - 1;
          continue;
        }
      }

      // 8. Fix network mode
      if (line.match(/^\s+network_mode:/) && line.includes('host')) {
        // Podman supports host networking but may need different syntax
        // Keep as-is for now, but log it
        changes.push(`Note: Using host network mode`);
      }

      // 9. Remove x-* extension fields (Docker Compose extensions)
      if (line.match(/^x-/)) {
        changes.push(`Removed Docker Compose extension: ${line.trim()}`);
        continue;
      }

      // 10. Fix build context with Docker-specific options
      if (line.match(/^\s+build:/)) {
        const nextLines = lines.slice(i + 1, i + 10);
        const hasCache = nextLines.some(l => l.includes('cache_from:') || l.includes('cache_to:'));
        if (hasCache) {
          changes.push(`Removed Docker BuildKit cache options`);
          let j = i + 1;
          while (j < lines.length && lines[j].match(/^\s{4,}/)) {
            if (!lines[j].includes('cache_from:') && !lines[j].includes('cache_to:')) {
              result.push(lines[j]);
            }
            j++;
          }
          result.push(line);
          i = j - 1;
          continue;
        }
      }

      // 11. Convert docker-compose wait/is_ready checks
      if (line.includes('docker-compose') && line.includes('exec')) {
        line = line.replace(/docker-compose/g, 'podman-compose');
        changes.push(`Converted docker-compose exec to podman-compose`);
      }

      // 12. Fix secrets/configs that reference Docker paths
      if ((line.match(/^\s+secrets:/) || line.match(/^\s+configs:/)) && inService) {
        // Podman supports secrets differently
        changes.push(`Note: Using secrets/configs - ensure Podman secret exists`);
      }

      // 13. Remove profiles (Docker Compose 1.28+)
      if (line.match(/^\s+profiles:/)) {
        changes.push(`Removed profiles (use podman-compose --profile instead)`);
        continue;
      }

      result.push(line);
    }

    sanitized = result.join('\n');

    if (changes.length > 0) {
      console.log('[ComposeSanitizer] Changes made:');
      changes.forEach(c => console.log(`  - ${c}`));
    }

  } catch (err) {
    console.warn('[ComposeSanitizer] Error during sanitization:', err.message);
    // Return original if parsing fails
    return content;
  }

  return sanitized;
}

/**
 * Convert Docker commands to Podman equivalents
 */
function convertDockerCommand(cmd) {
  if (!cmd) return cmd;
  
  let converted = cmd;

  // docker run -> podman run
  converted = converted.replace(/\bdocker\s+run\b/g, 'podman run');
  
  // docker exec -> podman exec
  converted = converted.replace(/\bdocker\s+exec\b/g, 'podman exec');
  
  // docker ps -> podman ps
  converted = converted.replace(/\bdocker\s+ps\b/g, 'podman ps');
  
  // docker logs -> podman logs
  converted = converted.replace(/\bdocker\s+logs\b/g, 'podman logs');
  
  // docker stop -> podman stop
  converted = converted.replace(/\bdocker\s+stop\b/g, 'podman stop');
  
  // docker rm -> podman rm
  converted = converted.replace(/\bdocker\s+rm\b/g, 'podman rm');
  
  // docker pull -> podman pull
  converted = converted.replace(/\bdocker\s+pull\b/g, 'podman pull');
  
  // docker build -> podman build
  converted = converted.replace(/\bdocker\s+build\b/g, 'podman build');
  
  // docker-compose -> podman-compose
  converted = converted.replace(/\bdocker-compose\b/g, 'podman-compose');
  
  // docker socket references
  converted = converted.replace(/\/var\/run\/docker\.sock/g, PODMAN_SOCKET);
  
  // Docker API URL references
  converted = converted.replace(/https?:\/\/localhost:2375/g, `unix://${PODMAN_SOCKET}`);
  converted = converted.replace(/tcp:\/\/localhost:2375/g, `unix://${PODMAN_SOCKET}`);
  
  // DOCKER_HOST env var in commands
  converted = converted.replace(/DOCKER_HOST=unix:\/var\/run\/docker\.sock/g, `DOCKER_HOST=unix://${PODMAN_SOCKET}`);
  
  // Remove --gpus flag (not supported in Podman, use --device instead)
  converted = converted.replace(/\s+--gpus\s+all/g, '');
  converted = converted.replace(/\s+--gpus\s+['"][^'"]+['"]/g, '');
  
  // Remove --runtime=nvidia (use --device nvidia.com/gpu=all instead - requires custom handling)
  converted = converted.replace(/\s+--runtime=nvidia/g, '');
  
  return converted;
}

/**
 * Check if a stack requires Docker-specific features that won't work with Podman
 */
export function checkDockerDependencies(content) {
  const issues = [];
  
  if (!content) return issues;
  
  // Check for Docker-in-Docker
  if (content.includes('/var/run/docker.sock') || content.includes('DOCKER_HOST')) {
    issues.push({
      type: 'warning',
      message: 'Stack requires Docker socket access. Some features may not work with Podman.',
    });
  }
  
  // Check for Docker Swarm mode
  if (content.includes('deploy:') && 
      (content.includes('replicas:') || content.includes('placement:'))) {
    issues.push({
      type: 'error',
      message: 'Stack uses Docker Swarm features which are not supported by Podman.',
    });
  }
  
  // Check for NVIDIA GPU runtime
  if (content.includes('runtime: nvidia') || content.includes('--gpus')) {
    issues.push({
      type: 'warning',
      message: 'Stack uses NVIDIA GPU. Podman requires different GPU configuration.',
    });
  }
  
  // Check for specific Docker-only images
  const dockerOnlyImages = [
    'docker:dind',
    'docker:stable-dind',
    'portainer/portainer',
    'portainer/portainer-ce',
    'containrrr/watchtower',
  ];
  
  for (const img of dockerOnlyImages) {
    if (content.includes(img)) {
      issues.push({
        type: 'warning',
        message: `Stack uses ${img} which may require Docker-specific features.`,
      });
    }
  }
  
  return issues;
}

/**
 * Get Podman-compatible version of a Docker image
 */
export function getPodmanImage(dockerImage) {
  // Most images work the same, but some Docker-specific ones need alternatives
  const mappings = {
    'docker:dind': null, // No equivalent - can't run Docker in Podman
    'docker:stable-dind': null,
    'portainer/portainer': 'portainer/portainer-ce', // Portainer CE works with Podman
    'portainer/portainer-ce': 'portainer/portainer-ce',
  };
  
  return mappings[dockerImage] || dockerImage;
}
