export const LAMBDA_ASSUME_ROLE_POLICY = Object.freeze({
  Version: "2012-10-17",
  Statement: [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    },
  ],
});

// Execution role for a Lambda in this stack (the .NET API, the Python MCP server): CloudWatch
// Logs only. Each function gets its own role so neither inherits a grant added for the other.
// No VPC, so no NAT — functions reach Neon, Clerk, and each other over the public internet
// with TLS. (This is the single biggest "silent billing" avoidance in the stack.)
export function createLambdaExecutionRole(roleName: string, logsAttachmentName: string) {
  const role = new aws.iam.Role(roleName, {
    assumeRolePolicy: JSON.stringify(LAMBDA_ASSUME_ROLE_POLICY),
  });
  new aws.iam.RolePolicyAttachment(logsAttachmentName, {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });
  return role;
}

// Grants a Lambda role exactly the S3 actions the document API performs, confined to one prefix
// of one bucket. Named actions on a specific ARN — never `s3:*` on `"*"`.
//
// Two statements because S3 splits permissions across two levels: object actions are authorized
// against the OBJECT arn (so the prefix does the confining), while ListBucket is a bucket-level
// action whose resource is the bucket itself — a resource ARN cannot narrow it, so the
// `s3:prefix` condition is what keeps listing inside the documents tree. Note the pattern
// `documents/*` also matches the bare `documents/` the health check lists, since IAM's
// StringLike `*` matches the empty string.
//
// The object actions cover more than they appear to: HeadObject authorizes as s3:GetObject, and
// a rename is CopyObject (s3:GetObject on the source + s3:PutObject on the destination) followed
// by DeleteObject. Presigned URLs need no extra grant — S3 evaluates THIS role's permissions when
// the browser redeems one, which is precisely why the prefix scope still holds for direct
// browser uploads.
export function grantDocumentsAccess(
  policyName: string,
  role: aws.iam.Role,
  bucketArn: $util.Input<string>,
  prefix: string,
) {
  return new aws.iam.RolePolicy(policyName, {
    role: role.id,
    policy: $util.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: $interpolate`${bucketArn}/${prefix}*`,
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: bucketArn,
          Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
        },
      ],
    }),
  });
}
