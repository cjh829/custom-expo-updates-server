import FormData from 'form-data';
import fs from 'fs/promises';
import { NextApiRequest, NextApiResponse } from 'next';
import { serializeDictionary } from 'structured-headers';

import {
  getAssetMetadataAsync,
  getMetadataAsync,
  convertSHA256HashToUUID,
  convertToDictionaryItemsRepresentation,
  signRSASHA256,
  getPrivateKeyAsync,
  getExpoConfigAsync,
  getLatestUpdateBundlePathForRuntimeVersionAsync,
  createRollBackDirectiveAsync,
  NoUpdateAvailableError,
  createNoUpdateAvailableDirectiveAsync,
} from '../../common/helpers';

export default async function manifestEndpoint(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.json({ error: 'Expected GET.' });
    console.error('manifest error1');
    return;
  }

  const protocolVersionMaybeArray = req.headers['expo-protocol-version'];
  if (protocolVersionMaybeArray && Array.isArray(protocolVersionMaybeArray)) {
    res.statusCode = 400;
    res.json({
      error: 'Unsupported protocol version. Expected either 0 or 1.',
    });
    console.error('manifest error2');
    return;
  }
  const protocolVersion = parseInt(protocolVersionMaybeArray ?? '0', 10);

  const platform = req.headers['expo-platform'] ?? req.query['platform'];
  if (platform !== 'ios' && platform !== 'android') {
    res.statusCode = 400;
    res.json({
      error: 'Unsupported platform. Expected either ios or android.',
    });
    console.error('manifest error3');
    return;
  }

  const runtimeVersion = req.headers['expo-runtime-version'] ?? req.query['runtime-version'];
  if (!runtimeVersion || typeof runtimeVersion !== 'string') {
    res.statusCode = 400;
    res.json({
      error: 'No runtimeVersion provided.',
    });
    console.error('manifest error4');
    return;
  }

  let updateBundlePath: string;
  try {
    updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
  } catch (error: any) {
    res.statusCode = 404;
    res.json({
      error: error.message,
    });

    console.error('manifest error5', error?.message);
    return;
  }

  console.error('manifest', updateBundlePath, runtimeVersion, platform, process.env.HOSTNAME);

  const updateType = await getTypeOfUpdateAsync(updateBundlePath);

  console.error('updateType', updateType);

  try {
    try {
      if (updateType === UpdateType.NORMAL_UPDATE) {
        console.error('manifest NORMAL_UPDATE1');
        await putUpdateInResponseAsync(
          req,
          res,
          updateBundlePath,
          runtimeVersion,
          platform,
          protocolVersion
        );
        console.error('manifest NORMAL_UPDATE2');
      } else if (updateType === UpdateType.ROLLBACK) {
        console.error('manifest ROLLBACK1');
        await putRollBackInResponseAsync(req, res, updateBundlePath, protocolVersion);
        console.error('manifest ROLLBACK2');
      }
    } catch (maybeNoUpdateAvailableError) {
      if (maybeNoUpdateAvailableError instanceof NoUpdateAvailableError) {
        await putNoUpdateAvailableInResponseAsync(req, res, protocolVersion);
        return;
      }
      throw maybeNoUpdateAvailableError;
    }
  } catch (error) {
    console.error(error);
    res.statusCode = 404;
    res.json({ error });
  }
}

enum UpdateType {
  NORMAL_UPDATE,
  ROLLBACK,
}

async function getTypeOfUpdateAsync(updateBundlePath: string): Promise<UpdateType> {
  const directoryContents = await fs.readdir(updateBundlePath);
  return directoryContents.includes('rollback') ? UpdateType.ROLLBACK : UpdateType.NORMAL_UPDATE;
}

async function putUpdateInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  updateBundlePath: string,
  runtimeVersion: string,
  platform: string,
  protocolVersion: number
): Promise<void> {
  const currentUpdateId = req.headers['expo-current-update-id'];
  const { metadataJson, createdAt, id } = await getMetadataAsync({
    updateBundlePath,
    runtimeVersion,
  });

  // NoUpdateAvailable directive only supported on protocol version 1
  // for protocol version 0, serve most recent update as normal
  if (currentUpdateId === id && protocolVersion === 1) {
    throw new NoUpdateAvailableError();
  }

  const expoConfig = await getExpoConfigAsync({
    updateBundlePath,
    runtimeVersion,
  });
  const platformSpecificMetadata = metadataJson.fileMetadata[platform];

  // 預設 protocol，當自動偵測失敗或結果不合法時使用
  const DEFAULT_PROTOCOL = 'https';

  // Node.js 中所有 header key 均為小寫，不可用大寫
  // protocol 偵測優先順序：
  // 1. x-forwarded-proto         (Nginx / ALB / CloudFront 標準 header)
  // 2. forwarded                 (RFC 7239，e.g. "for=1.2.3.4;proto=https")
  // 3. cloudfront-forwarded-proto (AWS CloudFront 專屬，比 x-forwarded-proto 更可靠)
  // 4. x-forwarded-ssl           (舊版 AWS ELB Classic，"on" = https)
  // 5. front-end-https           (Microsoft IIS/ARR，"on" = https)
  // 6. cf-visitor                (Cloudflare，JSON 格式 '{"scheme":"https"}')
  // 7. req.socket.encrypted      (TLS 直連)

  // --- 1. x-forwarded-proto ---
  const xForwardedProto = req.headers['x-forwarded-proto'] as string | undefined;
  const xForwardedHost  = req.headers['x-forwarded-host']  as string | undefined;

  // --- 2. forwarded (RFC 7239) ---
  const forwardedHeader = req.headers['forwarded'] as string | undefined;
  let forwardedHeaderProto: string | undefined;
  if (forwardedHeader) {
    const match = forwardedHeader.match(/proto=(https?)/i);
    if (match) forwardedHeaderProto = match[1].toLowerCase();
  }

  // --- 3. cloudfront-forwarded-proto (AWS CloudFront 專屬) ---
  const cfProto = req.headers['cloudfront-forwarded-proto'] as string | undefined;

  // --- 4. x-forwarded-ssl (舊版 AWS ELB Classic) ---
  const xForwardedSsl = req.headers['x-forwarded-ssl'] as string | undefined;
  const xForwardedSslProto = xForwardedSsl === 'on' ? 'https'
    : xForwardedSsl === 'off' ? 'http'
    : undefined;

  // --- 5. front-end-https (Microsoft IIS / ARR) ---
  const frontEndHttps = req.headers['front-end-https'] as string | undefined;
  const frontEndHttpsProto = frontEndHttps?.toLowerCase() === 'on' ? 'https' : undefined;

  // --- 6. cf-visitor (Cloudflare，JSON 格式) ---
  const cfVisitorRaw = req.headers['cf-visitor'] as string | undefined;
  let cfVisitorProto: string | undefined;
  if (cfVisitorRaw) {
    try {
      const cfVisitor = JSON.parse(cfVisitorRaw) as { scheme?: string };
      if (cfVisitor.scheme === 'https' || cfVisitor.scheme === 'http') {
        cfVisitorProto = cfVisitor.scheme;
      }
    } catch { /* JSON 解析失敗，忽略 */ }
  }

  // --- 7. socket.encrypted (TLS 直連) ---
  const socketProtocol = (req.socket as any).encrypted ? 'https' : 'http';

  // 依優先序合併，?? 確保只在 undefined/null 時才往下走
  const detectedProtocol =
    xForwardedProto?.split(',')[0].trim() ??
    forwardedHeaderProto ??
    cfProto ??
    xForwardedSslProto ??
    frontEndHttpsProto ??
    cfVisitorProto ??
    socketProtocol;

  // 驗證偵測結果是否合法，不合法則 fallback 到 DEFAULT_PROTOCOL
  const protocol = (detectedProtocol === 'https' || detectedProtocol === 'http')
    ? detectedProtocol
    : DEFAULT_PROTOCOL;

  const host = xForwardedHost || req.headers.host;

  // [DEBUG] 列出所有 request headers（便於確認 AWS/proxy 實際傳入了哪些 header）
  console.log('===putUpdateInResponseAsync [ALL HEADERS]', JSON.stringify(req.headers, null, 2));

  // [DEBUG] 列出各 protocol 偵測來源的值及最終結果
  console.log('===putUpdateInResponseAsync [PROTOCOL DETECTION]', {
    '1_x-forwarded-proto (raw)'       : xForwardedProto,
    '1_x-forwarded-proto (parsed)'    : xForwardedProto?.split(',')[0].trim(),
    '2_forwarded (raw)'               : forwardedHeader,
    '2_forwarded (parsed proto)'      : forwardedHeaderProto,
    '3_cloudfront-forwarded-proto'    : cfProto,
    '4_x-forwarded-ssl (raw)'         : xForwardedSsl,
    '4_x-forwarded-ssl (parsed)'      : xForwardedSslProto,
    '5_front-end-https (raw)'         : frontEndHttps,
    '5_front-end-https (parsed)'      : frontEndHttpsProto,
    '6_cf-visitor (raw)'              : cfVisitorRaw,
    '6_cf-visitor (parsed proto)'     : cfVisitorProto,
    '7_socket.encrypted'              : (req.socket as any).encrypted,
    '7_socketProtocol'                : socketProtocol,
    '=> detectedProtocol'             : detectedProtocol,
    '=> DEFAULT_PROTOCOL'             : DEFAULT_PROTOCOL,
    '=> finalProtocol'                : protocol,
    '=> host'                         : host,
  });

  const thisUrlWithoutPath = `${protocol}://${host}`;

  const manifest = {
    id: convertSHA256HashToUUID(id),
    createdAt,
    runtimeVersion,
    assets: await Promise.all(
      (platformSpecificMetadata.assets as any[]).map((asset: any) =>
        getAssetMetadataAsync({
          updateBundlePath,
          filePath: asset.path,
          ext: asset.ext,
          runtimeVersion,
          platform,
          isLaunchAsset: false,
          urlWithoutPath: thisUrlWithoutPath,
        })
      )
    ),
    launchAsset: await getAssetMetadataAsync({
      updateBundlePath,
      filePath: platformSpecificMetadata.bundle,
      isLaunchAsset: true,
      runtimeVersion,
      platform,
      ext: null,
      urlWithoutPath: thisUrlWithoutPath,
    }),
    metadata: {},
    extra: {
      expoClient: expoConfig,
    },
  };

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }

    const manifestString = JSON.stringify(manifest);

    //console.error('===manifestString',manifestString);

    const hashSignature = signRSASHA256(manifestString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const assetRequestHeaders: { [key: string]: object } = {};
  [...manifest.assets, manifest.launchAsset].forEach((asset) => {
    assetRequestHeaders[asset.key] = {
      'test-header': 'test-header-value',
    };
  });

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });
  form.append('extensions', JSON.stringify({ assetRequestHeaders }), {
    contentType: 'application/json',
  });

  //const logfilePath = __dirname + `/manifestform-${Date.now()}.log`;
  //console.error('===write to',logfilePath)
  //const mfs = require('fs');
  //mfs.writeFileSync(logfilePath, JSON.stringify(form))

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', protocolVersion);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', 'private, max-age=0');
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();
}

async function putRollBackInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  updateBundlePath: string,
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    throw new Error('Rollbacks not supported on protocol version 0');
  }

  const embeddedUpdateId = req.headers['expo-embedded-update-id'];
  if (!embeddedUpdateId || typeof embeddedUpdateId !== 'string') {
    throw new Error('Invalid Expo-Embedded-Update-ID request header specified.');
  }

  const currentUpdateId = req.headers['expo-current-update-id'];
  if (currentUpdateId === embeddedUpdateId) {
    throw new NoUpdateAvailableError();
  }

  const directive = await createRollBackDirectiveAsync(updateBundlePath);

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = signRSASHA256(directiveString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', 1);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', 'private, max-age=0');
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();
}

async function putNoUpdateAvailableInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    throw new Error('NoUpdateAvailable directive not available in protocol version 0');
  }

  const directive = await createNoUpdateAvailableDirectiveAsync();

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = signRSASHA256(directiveString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', 1);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', 'private, max-age=0');
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();
}
